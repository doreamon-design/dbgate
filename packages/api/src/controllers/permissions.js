// 团队权限管理端路由（社区版）。
//
// 路由名与 permissions 权限点刻意对齐 Team(Premium) 版 storage 控制器的管理端约定
// （packages/api/src/controllers/storage.test.js 里的 ADMIN_ROUTES 对照表）：
//   getUserList / getUserDetail / saveUserDetail / deleteUser          → admin/users
//   getRoleList / getRoleDetail / saveRoleDetail / deleteRole          → admin/roles
// 差别只在于：社区版把数据落在本地 JSON（utility/permissionStore），不依赖 STORAGE_DATABASE。
//
// 每条路由都必须先索要 admin/<x> 权限；handler 内部调用（没有 req）不做检查，
// 与 storage 控制器保持一致。

const { getLogger, extractErrorLogData } = require('dbgate-tools');
const { testStandardPermission } = require('../utility/hasPermission');
const store = require('../utility/permissionStore');
const {
  DATABASE_ROLE_ID_NAMES,
  TABLE_ROLE_ID_NAMES,
  TABLE_SCOPE_ID_NAMES,
  DATABASE_ROLE_ORDER,
  TABLE_ROLE_ORDER,
} = require('../utility/permissionLevels');

const logger = getLogger('permissions');

const PERMISSION_USERS = 'admin/users';
const PERMISSION_ROLES = 'admin/roles';

function isHttpRequest(req) {
  return !!req;
}

module.exports = {
  async _init() {
    try {
      const res = store.ensureBootstrap();
      if (res.created) logger.info(`DBGM-00000 Permission store initialized (${res.userCount} users)`);
    } catch (err) {
      // 引导失败不能拖垮 API：存储不存在时 isPermissionStoreActive() 为 false，
      // 一切权限判定退回改造前的行为。
      logger.error(extractErrorLogData(err), 'DBGM-00000 Error initializing permission store');
    }
  },

  getSummary_meta: true,
  async getSummary(_params, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_USERS, req);
    return store.getStoreSummary();
  },

  // 前端需要的档位/范围选项，避免前后端各写一份
  getOptions_meta: true,
  async getOptions(_params, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    const asOptions = map =>
      Object.keys(map).map(id => ({ id: Number(id), name: map[id] }));
    return {
      databaseRoles: asOptions(DATABASE_ROLE_ID_NAMES),
      tableRoles: asOptions(TABLE_ROLE_ID_NAMES),
      tableScopes: asOptions(TABLE_SCOPE_ID_NAMES),
      databaseRoleOrder: DATABASE_ROLE_ORDER,
      tableRoleOrder: TABLE_ROLE_ORDER,
      superAdminPermission: store.SUPER_ADMIN_PERMISSION,
      builtinRoles: {
        superadmin: store.ROLE_SUPERADMIN,
        unassigned: store.ROLE_UNASSIGNED,
        legacy: store.ROLE_LEGACY,
      },
    };
  },

  // ------------------------------------------------------------ 成员

  getUserList_meta: true,
  async getUserList(_params, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_USERS, req);
    return { users: store.listUsers(), roles: store.listRoles() };
  },

  getUserDetail_meta: true,
  async getUserDetail({ userId }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_USERS, req);
    const user = store.getUser(userId);
    if (!user) throw new Error(`DBGM-00000 User "${userId}" not found`);
    return {
      user,
      roles: store.listRoles(),
      permissions: store.buildUserPermissions(user),
      summary: store.getStoreSummary(),
    };
  },

  saveUserDetail_meta: true,
  async saveUserDetail({ user }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_USERS, req);
    const saved = store.saveUser(user);
    return { user: saved };
  },

  deleteUser_meta: true,
  async deleteUser({ userId }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_USERS, req);
    return { deleted: store.deleteUser(userId) };
  },

  // ------------------------------------------------------------ 角色

  getRoleList_meta: true,
  async getRoleList(_params, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    return { roles: store.listRoles(), users: store.listUsers() };
  },

  getRoleDetail_meta: true,
  async getRoleDetail({ roleId }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    const role = store.getRole(roleId);
    if (!role) throw new Error(`DBGM-00000 Role "${roleId}" not found`);
    return {
      role,
      connections: store.listRoleConnections(roleId),
      databases: store.listRoleDatabases(roleId),
      tables: store.listRoleTables(roleId),
    };
  },

  saveRoleDetail_meta: true,
  async saveRoleDetail({ role, connections, databases, tables }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    const saved = store.saveRole(role ?? {});
    if (connections) store.setRoleConnections(saved.id, connections.all ? [] : connections.ids ?? []);
    if (Array.isArray(databases)) {
      for (const row of store.listRoleDatabases(saved.id)) store.deleteRoleDatabase(row.id);
      for (const row of databases) store.saveRoleDatabase({ ...row, role_id: saved.id });
    }
    if (Array.isArray(tables)) {
      for (const row of store.listRoleTables(saved.id)) store.deleteRoleTable(row.id);
      for (const row of tables) store.saveRoleTable({ ...row, role_id: saved.id });
    }
    return this.getRoleDetail({ roleId: saved.id }, null);
  },

  deleteRole_meta: true,
  async deleteRole({ roleId }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    return { deleted: store.deleteRole(roleId) };
  },

  // ------------------------------------------------------------ 授权（细粒度，供访问矩阵单格修改）

  saveRoleDatabase_meta: true,
  async saveRoleDatabase(row, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    return { row: store.saveRoleDatabase(row) };
  },

  deleteRoleDatabase_meta: true,
  async deleteRoleDatabase({ rowId }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    return { deleted: store.deleteRoleDatabase(rowId) };
  },

  saveRoleTable_meta: true,
  async saveRoleTable(row, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    return { row: store.saveRoleTable(row) };
  },

  deleteRoleTable_meta: true,
  async deleteRoleTable({ rowId }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    return { deleted: store.deleteRoleTable(rowId) };
  },

  setRoleConnections_meta: true,
  async setRoleConnections({ roleId, connectionIds }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    return { connections: store.setRoleConnections(roleId, connectionIds ?? []) };
  },

  // ------------------------------------------------------------ 连接清单（给角色编辑器勾选）

  getConnectionList_meta: true,
  async getConnectionList(_params, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    // 懒加载：connections 控制器会 require hasPermission，顶层互相 require 容易成环
    const list = await require('./connections').list({}, req);
    return {
      connections: (list ?? []).map(c => ({
        conid: c._id,
        name: c.displayName || c.name || c._id,
        engine: c.engine,
        server: c.server,
        database: c.database,
      })),
    };
  },
};
