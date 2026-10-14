// 哆啦A梦登录适配：go-zoox/connect 网关注入 X-Connect-Token（JWT, HS256, SESSION_KEY 签名），
// DbGate 只负责校验并把身份落成本地成员，授权仍然走本地角色（permissionStore）。
//
// 契约（已核对 go-zoox/connect v1.20.1 的 user/user.go）：
//   claims = id / nickname / avatar / email / username / feishu_open_id / permissions[]
//   header 优先级：header X-Connect-Token → query X-Connect-Token → query access_token
//   permissions 缺失或格式不对 = 空数组 = 无权限（connect 的 decodePermissions 就是这么定的）

const jwt = require('jsonwebtoken');
const { getLogger } = require('dbgate-tools');
const store = require('../utility/permissionStore');

const logger = getLogger('connectAuthProvider');

const AMOID = 'connect';

function isConnectAuthEnabled() {
  return store.isConnectAuthEnabled();
}

function readConnectToken(req) {
  if (!req) return null;
  const fromHeader = req.headers?.['x-connect-token'];
  if (fromHeader) return fromHeader;
  const fromQuery = req.query?.['X-Connect-Token'];
  if (fromQuery) return fromQuery;
  const fromAccessToken = req.query?.access_token;
  if (fromAccessToken) return fromAccessToken;
  return null;
}

// connect 的 decodePermissions：不是数组就当作没有权限；数组里只要字符串项
function normalizePermissions(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === 'string' && item !== '');
}

function connectUserFromPayload(payload = {}) {
  const id = payload.id || '';
  const email = payload.email || '';
  const username = payload.username || '';
  return {
    id,
    email,
    nickname: payload.nickname || '',
    avatar: payload.avatar || '',
    feishuOpenId: payload.feishu_open_id || '',
    // 与 connect 的兼容逻辑一致：username 缺失时用 email，再退到 id
    login: username || email || id,
    permissions: normalizePermissions(payload.permissions),
  };
}

/**
 * 校验网关透传的 token。
 * @returns {null} 没有 token（交给常规登录流程）
 *          {{error: string}} 有 token 但校验失败 —— 必须拒绝，不能静默降级
 *          {{connectUser}} 校验通过
 */
function decodeConnectToken(req) {
  if (!isConnectAuthEnabled()) return null;
  const secret = store.getConnectSecret();
  if (!secret) return { error: 'SESSION_KEY (or SECRET_KEY) is not configured' };

  const token = readConnectToken(req);
  if (!token) return null;

  try {
    const payload = jwt.verify(token, secret);
    return { connectUser: connectUserFromPayload(payload), payload };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * 把 connect 身份落到本地成员，并应用 SUPER_ADMIN 规则。
 * @returns {{user, action, changed, isNew}|null}
 */
function materializeMember(connectUser, meta) {
  if (!connectUser?.login) return null;
  try {
    return store.upsertConnectMember(connectUser, meta);
  } catch (err) {
    logger.error({ err }, 'DBGM-00000 Error upserting member from connect login');
    return null;
  }
}

function resolveMember(req) {
  const userId = req?.user?.userId;
  if (userId) {
    const byId = store.getUser(userId);
    if (byId) return byId;
  }
  const login = req?.user?.login;
  if (login) return store.findUserForLogin(login);
  return null;
}

/**
 * 工厂而不是直接导出类：AuthProviderBase 在 authProvider.js 里定义，
 * 直接 require 会形成循环依赖（authProvider 也要 require 本模块来注册 provider）。
 * 由 authProvider.js 在文件末尾把基类传进来。
 */
function createConnectAuthProvider(AuthProviderBase) {
  class ConnectAuthProvider extends AuthProviderBase {
    amoid = AMOID;
    skipInList = false;

    async getCurrentPermissions(req) {
      const user = resolveMember(req);
      // 找不到成员（或已停用）时返回显式的「全拒绝」：
      // hasPermission() 对 falsy 是放行的（fail-open），绝不能返回 null/空数组。
      if (!user) return [...store.DENY_ALL_PERMISSIONS];
      return store.buildUserPermissions(user);
    }

    async checkCurrentConnectionPermission(req, conid) {
      const user = resolveMember(req);
      if (!user || store.isUserDenied(user)) return false;
      const granted = store.grantedConnections(user);
      return granted.all || granted.ids.includes(conid);
    }

    async getCurrentDatabasePermissions(req) {
      return store.getUserDatabasePermissions(resolveMember(req));
    }

    async getCurrentTablePermissions(req) {
      return store.getUserTablePermissions(resolveMember(req));
    }

    async getCurrentFilePermissions() {
      return [];
    }

    // 列脱敏规则（已摊平成 {table, column, mode}），由结果管线在返回前应用
    async getCurrentColumnMaskRules(req, conid, database) {
      const user = resolveMember(req);
      if (!user) return [];
      return store.getUserColumnMaskRules(user, conid, database);
    }

    getLogoutUrl() {
      return process.env.CONNECT_LOGOUT_URL || null;
    }

    toJson() {
      return {
        amoid: AMOID,
        workflowType: 'redirect',
        name: '哆啦A梦登录',
      };
    }
  }

  return ConnectAuthProvider;
}

module.exports = {
  AMOID,
  isConnectAuthEnabled,
  readConnectToken,
  normalizePermissions,
  connectUserFromPayload,
  decodeConnectToken,
  materializeMember,
  resolveMember,
  createConnectAuthProvider,
};
