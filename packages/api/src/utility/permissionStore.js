// 社区版的权限存储：一个 JSON 文件（默认 <datadir>/permissions.json）。
//
// 设计约束：
// - 全同步读写。useController 的 _init() 是同步调用的，引导（bootstrap）必须在那时就完成，
//   否则第一批请求会在「存储还没建好」的状态下走到 fail-open 分支。
// - 授权行的列名与 packages/api/src/storageModel.js 的 role_connections / role_databases /
//   role_tables 同名同义（含数字态位 id），便于将来与 Team(Premium) 版互导。
// - 每次调用重新读文件：这个文件很小，而管理员改动必须立刻对下一个请求生效；
//   写用「临时文件 + rename」保证原子性。

const fs = require('fs');
const path = require('path');
const { getLogger } = require('dbgate-tools');
const { datadir } = require('./directories');
const { MASK_MODES, buildColumnMaskRules } = require('./columnMasking');
const { ALLOWED_OPERATORS, ALLOWED_USER_FIELDS, VALUE_TYPES, buildRowFilterRules } = require('./rowFiltering');
const {
  DATABASE_ROLE_NAME_IDS,
  TABLE_ROLE_NAME_IDS,
  TABLE_SCOPE_NAME_IDS,
  DATABASE_ROLE_ID_NAMES,
  TABLE_ROLE_ID_NAMES,
  TABLE_SCOPE_ID_NAMES,
} = require('./permissionLevels');

const logger = getLogger('permissionStore');

const STORE_VERSION = 1;
const STORE_FILE_NAME = 'permissions.json';

// 团队模式的权限基线。
//
// 为什么必须逐条 deny：DSL 是「默认允许、`*` 匹配一切、后面的覆盖前面的」
// （packages/tools/src/testPermission.ts）。基线的 `*` 会让 hasPermission('all-databases')
// 这类**白名单短路**判定全部为真，从而绕过角色级授权。所以凡是引擎里用 hasPermission 做
// 「是否放开全部」的判定，都必须在这里先 deny，再由角色显式放开：
//   all-connections  → testConnectionPermission / 连接列表过滤
//   all-databases    → testDatabaseRolePermission / 数据库列表过滤
//   all-tables       → 表级过滤（databaseConnections）/ 服务端 SQL chat
//   connections/*    → 社区版按 connections/<conid> 逐条判定，必须先 deny 再逐条放行
//   all-disk-files   → 磁盘文件列表
const TEAM_BASE_PERMISSIONS = [
  '*',
  '~widgets/admin',
  '~admin/*',
  '~internal-storage',
  '~all-connections',
  '~all-databases',
  '~all-tables',
  '~all-disk-files',
  '~connections/*',
  '~run-shell-script',
  '~all-team-files/*',
];

// 注意：不能用空数组表示「全拒绝」。hasPermission() 只在 loadedPermissions 为 falsy 时放行，
// 但 compilePermissions([]) 会得到空 levels，testPermission 仍然返回 true —— 也就是「全放行」。
// 必须给一个非空的、能匹配一切的 deny。
const DENY_ALL_PERMISSIONS = ['~*'];

const ROLE_SUPERADMIN = 'superadmin';
const ROLE_UNASSIGNED = 'unassigned';
const ROLE_LEGACY = 'legacy-all';

const SUPER_ADMIN_PERMISSION = 'SUPER_ADMIN';
const SUPER_ADMIN_ROLE_ID = -3;

// 最近登录信息不必每个请求都落盘
const PROFILE_REFRESH_INTERVAL_MS = 60 * 1000;

function isTruthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function isConnectAuthEnabled() {
  // 只认显式开关：SECRET_KEY 这类通用名字在很多部署里另有用途，
  // 用它当触发器会让「本来不打算接网关」的部署突然要求 X-Connect-Token。
  return isTruthy(process.env.CONNECT_AUTH);
}

function getConnectSecret() {
  return process.env.SESSION_KEY || process.env.SECRET_KEY || null;
}

function storeFilePath() {
  return path.join(datadir(), STORE_FILE_NAME);
}

// 权限存储是否生效。storage 数据库（Team Premium 路径）与本地文件二选一；
// 两者都没有时，一切权限判定与改造前完全一致。
function isPermissionStoreActive() {
  if (process.env.STORAGE_DATABASE) return true;
  if (isConnectAuthEnabled()) return true;
  try {
    return fs.existsSync(storeFilePath());
  } catch (err) {
    return false;
  }
}

function emptyStore() {
  return {
    version: STORE_VERSION,
    users: [],
    roles: [],
    roleConnections: [],
    roleDatabases: [],
    roleTables: [],
    roleColumns: [],
    roleRowFilters: [],
    changeLog: [],
  };
}

function readStore() {
  const file = storeFilePath();
  try {
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object') return null;
    return {
      ...emptyStore(),
      ...data,
    };
  } catch (err) {
    logger.error({ err }, 'DBGM-00000 Error reading permission store');
    return null;
  }
}

function writeStore(data) {
  const file = storeFilePath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function nextId(prefix, existing) {
  let index = existing.length + 1;
  while (existing.some(x => x.id === `${prefix}${index}`)) index++;
  return `${prefix}${index}`;
}

// ---------------------------------------------------------------- 内置角色

function builtinRoles() {
  return [
    {
      id: ROLE_SUPERADMIN,
      name: '超级管理员',
      builtin: true,
      auto: true,
      description: '全部连接、全部数据库、全部管理功能。由哆啦A梦 SUPER_ADMIN 自动授予，不可手工删除。',
      // ★ widgets/admin 是"管理面板"的渲染门槛：WidgetContainer 里是
      //   {#if $visibleSelectedWidget == 'admin' && hasPermission('widgets/admin')}
      //   TEAM_BASE_PERMISSIONS 把它 deny 了，所以角色里必须显式放行，
      //   否则连超管都看不到成员/角色/矩阵面板（曾漏配，功能整块不可见）。
      permissions: ['widgets/admin', 'all-connections', 'all-databases', 'all-tables', 'admin/*', 'internal-storage'],
    },
    {
      id: ROLE_UNASSIGNED,
      name: '待分配',
      builtin: true,
      description: '新成员首次登录时的默认角色：没有任何库权限，等管理员分配。',
      permissions: ['widgets/database'],
    },
    {
      id: ROLE_LEGACY,
      name: '升级前兼容',
      builtin: true,
      description:
        '首次启动时自动创建，赋给升级前就存在的登录。保留改造前的行为（可见全部连接与数据库）；成员接入后请换成按岗位划分的角色。',
      permissions: ['all-connections', 'all-databases', 'all-tables'],
    },
  ];
}

// ---------------------------------------------------------------- 引导

function collectEnvLogins() {
  const res = [];
  if (process.env.LOGIN) res.push(process.env.LOGIN);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('LOGIN_PASSWORD_')) {
      const login = key.slice('LOGIN_PASSWORD_'.length);
      if (login) res.push(login);
    }
  }
  return [...new Set(res)];
}

/**
 * 首次启动时把存储建起来。
 * 关键：把「升级前就存在的登录」都建成成员并给 ROLE_LEGACY（all-connections + all-databases），
 * 这样打开权限存储不会把老部署的访问权限一夜之间收走。
 */
/**
 * 内置角色的定义以代码为准（幂等刷新）。
 * 否则修内置角色权限时，已经写过 permissions.json 的部署拿不到修复。
 * 只动内置角色；成员自建的角色及其上的连接/库/对象/脱敏规则一律不碰。
 */
function refreshBuiltinRoles(data) {
  let changed = false;
  for (const role of builtinRoles()) {
    const index = data.roles.findIndex(row => row.id === role.id);
    if (index < 0) {
      data.roles.push(role);
      changed = true;
      continue;
    }
    const current = data.roles[index];
    if (
      current.name !== role.name ||
      current.description !== role.description ||
      JSON.stringify(current.permissions ?? []) !== JSON.stringify(role.permissions)
    ) {
      data.roles[index] = { ...current, ...role };
      changed = true;
    }
  }
  if (changed) writeStore(data);
  return changed;
}

function ensureBootstrap() {
  const existing = readStore();
  if (existing) {
    refreshBuiltinRoles(existing);
    return { created: false, userCount: existing.users.length, roleCount: existing.roles.length };
  }

  const data = emptyStore();
  data.roles = builtinRoles();

  const logins = collectEnvLogins();
  for (const login of logins) {
    data.users.push({
      id: `u-${login}`,
      login,
      name: login,
      email: '',
      connectUserId: '',
      source: '环境变量导入',
      roles: [ROLE_LEGACY],
      status: 'active',
      superAdminSource: null,
      createdAt: new Date().toISOString(),
      lastLogin: '',
      lastIp: '',
      tenant: '',
    });
  }

  if (process.env.ADMIN_PASSWORD) {
    // 管理员密码登录（controllers/auth.js 的 login({isAdminPage:true})）签发的是
    // { login:'superadmin', roleId:-3, amoid:'superadmin' }。存储里必须有对应成员，
    // 否则一旦权限存储成为默认来源，这条路会变成「查不到成员 → 全拒绝」。
    // 标记为 local：这是本地兜底管理员，不会被哆啦A梦的自动降级摘掉。
    data.users.push({
      id: 'u-superadmin',
      login: 'superadmin',
      name: '本地管理员（ADMIN_PASSWORD）',
      email: '',
      connectUserId: '',
      source: '本地密码',
      roles: [ROLE_SUPERADMIN],
      status: 'active',
      superAdminSource: 'local',
      createdAt: new Date().toISOString(),
      lastLogin: '',
      lastIp: '',
      tenant: '',
    });
  }

  if (!data.users.length) {
    // 没有配任何登录名（匿名/单管理员部署）：建一个本地管理员，
    // 效果与改造前一致，等接入哆啦A梦后由 SUPER_ADMIN 自动接管。
    data.users.push({
      id: 'u-admin',
      login: process.env.LOGIN || 'admin',
      name: '本地管理员',
      email: '',
      connectUserId: '',
      source: '本地',
      roles: [ROLE_LEGACY],
      status: 'active',
      superAdminSource: 'local',
      createdAt: new Date().toISOString(),
      lastLogin: '',
      lastIp: '',
      tenant: '',
    });
  }

  writeStore(data);
  logger.info(
    `DBGM-00000 Permission store created at ${storeFilePath()} (${data.users.length} users, ${data.roles.length} roles)`
  );
  return { created: true, userCount: data.users.length, roleCount: data.roles.length };
}

// ---------------------------------------------------------------- 角色

const USERNAME_ONLY = /^[\w.@-]+$/;

function normalizeLimits(limits) {
  return {
    // 0 / 空 = 不限
    maxRows: Math.max(0, Number(limits?.maxRows) || 0),
    timeoutSeconds: Math.max(0, Number(limits?.timeoutSeconds) || 0),
    // "09:00-18:00"（本地时区）；空 = 不限
    allowedHours: String(limits?.allowedHours ?? '').trim(),
    // 逗号分隔的 IP 或简单前缀（10.20. / 10.20.1.5）；空 = 不限
    allowedIps: String(limits?.allowedIps ?? '').trim(),
  };
}

function normalizeRole(role) {
  return {
    id: role.id,
    name: role.name ?? role.id,
    builtin: !!role.builtin,
    auto: !!role.auto,
    personal: !!role.personal,
    description: role.description ?? '',
    permissions: Array.isArray(role.permissions) ? role.permissions : [],
    connections: role.connections ?? null,
    limits: normalizeLimits(role.limits),
  };
}

function listRoles() {
  const data = readStore();
  if (!data) return [];
  return data.roles.map(normalizeRole);
}

function getRole(roleId) {
  return listRoles().find(x => x.id === roleId) ?? null;
}

function saveRole(role) {
  const data = readStore();
  if (!data) throw new Error('DBGM-00000 Permission store is not initialized');
  const existing = data.roles.find(x => x.id === role.id);
  let roleId = role.id;
  if (!existing) {
    if (!role.name) throw new Error('DBGM-00000 Role name is required');
    roleId = role.id || nextId('role-', data.roles);
    data.roles.push(normalizeRole({ ...role, id: roleId }));
  } else {
    const merged = existing.builtin
      ? // 内置角色的功能权限由代码决定，不允许改（否则可能把自己锁在外面）
        { ...existing, ...role, permissions: existing.permissions, builtin: true, id: existing.id }
      : { ...existing, ...role, id: existing.id };
    Object.assign(existing, normalizeRole(merged));
    roleId = existing.id;
  }
  writeStore(data);
  return getRole(roleId);
}

function deleteRole(roleId) {
  const data = readStore();
  if (!data) throw new Error('DBGM-00000 Permission store is not initialized');
  const role = data.roles.find(x => x.id === roleId);
  if (!role) return false;
  if (role.builtin) throw new Error('DBGM-00000 Built-in roles cannot be deleted');
  const usedBy = data.users.filter(u => u.roles.includes(roleId));
  if (usedBy.length) {
    throw new Error(`DBGM-00000 Role is assigned to ${usedBy.length} user(s), reassign them first`);
  }
  data.roles = data.roles.filter(x => x.id !== roleId);
  data.roleConnections = data.roleConnections.filter(x => x.role_id !== roleId);
  data.roleDatabases = data.roleDatabases.filter(x => x.role_id !== roleId);
  data.roleTables = data.roleTables.filter(x => x.role_id !== roleId);
  data.roleColumns = (data.roleColumns ?? []).filter(x => x.role_id !== roleId);
  data.roleRowFilters = (data.roleRowFilters ?? []).filter(x => x.role_id !== roleId);
  writeStore(data);
  return true;
}

// ---------------------------------------------------------------- 成员

function normalizeUser(user) {
  return {
    id: user.id,
    login: user.login,
    name: user.name ?? user.login,
    email: user.email ?? '',
    connectUserId: user.connectUserId ?? '',
    source: user.source ?? '本地',
    roles: Array.isArray(user.roles) ? user.roles : [],
    status: user.status ?? 'active',
    superAdminSource: user.superAdminSource ?? null,
    createdAt: user.createdAt ?? '',
    lastLogin: user.lastLogin ?? '',
    lastIp: user.lastIp ?? '',
    tenant: user.tenant ?? '',
    expires: user.expires ?? '',
  };
}

function listUsers() {
  const data = readStore();
  if (!data) return [];
  return data.users.map(normalizeUser);
}

function getUser(userId) {
  const data = readStore();
  if (!data) return null;
  const found = data.users.find(x => x.id === userId || x.login === userId);
  return found ? normalizeUser(found) : null;
}

function saveUser(user) {
  const data = readStore();
  if (!data) throw new Error('DBGM-00000 Permission store is not initialized');
  const login = String(user.login ?? '').trim();
  if (!login) throw new Error('DBGM-00000 Login is required');
  if (!USERNAME_ONLY.test(login)) throw new Error('DBGM-00000 Login contains unsupported characters');
  const roles = (user.roles ?? []).filter(r => data.roles.some(x => x.id === r));
  if (!roles.length) throw new Error('DBGM-00000 At least one role is required');

  const existing = data.users.find(x => x.id === user.id || x.login === login);
  if (existing) {
    // 哆啦A梦自动授予的超级管理员不能被本地摘掉
    if (existing.superAdminSource === 'doreamon' && !roles.includes(ROLE_SUPERADMIN)) roles.push(ROLE_SUPERADMIN);
    Object.assign(existing, normalizeUser({ ...existing, ...user, login, roles, id: existing.id }));
  } else {
    data.users.push(normalizeUser({ ...user, id: user.id || `u-${login}`, login, roles }));
  }
  writeStore(data);
  return getUser(existing ? existing.id : user.id || `u-${login}`);
}

function saveUserRaw(data, user) {
  const index = data.users.findIndex(x => x.id === user.id);
  if (index >= 0) data.users[index] = user;
  else data.users.push(user);
}

function deleteUser(userId) {
  const data = readStore();
  if (!data) throw new Error('DBGM-00000 Permission store is not initialized');
  const user = data.users.find(x => x.id === userId);
  if (!user) return false;
  // 至少要留一个能进管理界面的超级管理员，否则谁都改不回来
  const remaining = data.users.filter(u => u.id !== userId && u.roles.includes(ROLE_SUPERADMIN));
  if (user.roles.includes(ROLE_SUPERADMIN) && !remaining.length) {
    throw new Error('DBGM-00000 Cannot delete the last superadmin');
  }
  data.users = data.users.filter(x => x.id !== userId);
  writeStore(data);
  return true;
}

// ---------------------------------------------------------------- 授权行

function listRoleConnections(roleId = null) {
  const data = readStore();
  if (!data) return [];
  return data.roleConnections.filter(x => !roleId || x.role_id === roleId);
}

function setRoleConnections(roleId, connectionIds) {
  const data = readStore();
  if (!data) throw new Error('DBGM-00000 Permission store is not initialized');
  const ids = [...new Set(connectionIds ?? [])];
  data.roleConnections = data.roleConnections.filter(x => x.role_id !== roleId);
  for (const connectionId of ids) {
    data.roleConnections.push({ id: nextId('rc', data.roleConnections), role_id: roleId, connection_id: connectionId });
  }
  writeStore(data);
  return listRoleConnections(roleId);
}

function listRoleDatabases(roleId = null) {
  const data = readStore();
  if (!data) return [];
  return data.roleDatabases.filter(x => !roleId || x.role_id === roleId);
}

function saveRoleDatabase(row) {
  const data = readStore();
  if (!data) throw new Error('DBGM-00000 Permission store is not initialized');
  if (!row.role_id) throw new Error('DBGM-00000 role_id is required');
  const levelId =
    row.database_role != null ? DATABASE_ROLE_NAME_IDS[row.database_role] : Number(row.database_permission_role_id);
  if (!Object.values(DATABASE_ROLE_NAME_IDS).includes(levelId)) {
    throw new Error('DBGM-00000 Unknown database permission role');
  }
  const item = {
    id: row.id || nextId('rd', data.roleDatabases),
    role_id: row.role_id,
    connection_id: row.connection_id ?? '',
    database_names_list: row.database_names_list ?? '',
    database_names_regex: row.database_names_regex ?? '',
    database_permission_role_id: levelId,
  };
  const index = data.roleDatabases.findIndex(x => x.id === item.id);
  if (index >= 0) data.roleDatabases[index] = item;
  else data.roleDatabases.push(item);
  writeStore(data);
  return item;
}

function deleteRoleDatabase(rowId) {
  const data = readStore();
  if (!data) return false;
  const before = data.roleDatabases.length;
  data.roleDatabases = data.roleDatabases.filter(x => x.id !== rowId);
  if (data.roleDatabases.length === before) return false;
  writeStore(data);
  return true;
}

function listRoleTables(roleId = null) {
  const data = readStore();
  if (!data) return [];
  return data.roleTables.filter(x => !roleId || x.role_id === roleId);
}

function saveRoleTable(row) {
  const data = readStore();
  if (!data) throw new Error('DBGM-00000 Permission store is not initialized');
  if (!row.role_id) throw new Error('DBGM-00000 role_id is required');
  const roleId = TABLE_ROLE_NAME_IDS[row.table_role] ?? Number(row.table_permission_role_id);
  const scopeId = TABLE_SCOPE_NAME_IDS[row.table_scope] ?? Number(row.table_permission_scope_id);
  if (!Object.values(TABLE_ROLE_NAME_IDS).includes(roleId)) throw new Error('DBGM-00000 Unknown table permission role');
  if (!Object.values(TABLE_SCOPE_NAME_IDS).includes(scopeId))
    throw new Error('DBGM-00000 Unknown table permission scope');
  const item = {
    id: row.id || nextId('rt', data.roleTables),
    role_id: row.role_id,
    connection_id: row.connection_id ?? '',
    database_names_list: row.database_names_list ?? '',
    database_names_regex: row.database_names_regex ?? '',
    schema_names_list: row.schema_names_list ?? '',
    schema_names_regex: row.schema_names_regex ?? '',
    table_names_list: row.table_names_list ?? '',
    table_names_regex: row.table_names_regex ?? '',
    table_permission_role_id: roleId,
    table_permission_scope_id: scopeId,
  };
  const index = data.roleTables.findIndex(x => x.id === item.id);
  if (index >= 0) data.roleTables[index] = item;
  else data.roleTables.push(item);
  writeStore(data);
  return item;
}

function deleteRoleTable(rowId) {
  const data = readStore();
  if (!data) return false;
  const before = data.roleTables.length;
  data.roleTables = data.roleTables.filter(x => x.id !== rowId);
  if (data.roleTables.length === before) return false;
  writeStore(data);
  return true;
}

function listRoleColumns(roleId = null) {
  const data = readStore();
  if (!data) return [];
  return (data.roleColumns ?? []).filter(x => !roleId || x.role_id === roleId);
}

function saveRoleColumn(row) {
  const data = readStore();
  if (!data) throw new Error('DBGM-00000 Permission store is not initialized');
  if (!row.role_id) throw new Error('DBGM-00000 role_id is required');
  if (!MASK_MODES.includes(row.column_mask_mode)) throw new Error('DBGM-00000 Unknown column mask mode');
  if (!String(row.column_names_list ?? '').trim()) throw new Error('DBGM-00000 At least one column is required');
  data.roleColumns = data.roleColumns ?? [];
  const item = {
    id: row.id || nextId('rc', data.roleColumns),
    role_id: row.role_id,
    connection_id: row.connection_id ?? '',
    database_names_list: row.database_names_list ?? '',
    table_names_list: row.table_names_list ?? '',
    column_names_list: row.column_names_list ?? '',
    column_mask_mode: row.column_mask_mode,
  };
  const index = data.roleColumns.findIndex(x => x.id === item.id);
  if (index >= 0) data.roleColumns[index] = item;
  else data.roleColumns.push(item);
  writeStore(data);
  return item;
}

function deleteRoleColumn(rowId) {
  const data = readStore();
  if (!data) return false;
  data.roleColumns = data.roleColumns ?? [];
  const before = data.roleColumns.length;
  data.roleColumns = data.roleColumns.filter(x => x.id !== rowId);
  if (data.roleColumns.length === before) return false;
  writeStore(data);
  return true;
}

/**
 * 某个成员在 (conid, database) 上生效的列脱敏规则（已摊平成 {table, column, mode}）。
 * 只取「成员角色里、连接与库都命中」的行；表留空 = 匹配任意表。
 */
/** 该成员是否配了任何列脱敏（不限连接/库）—— 用于无法按库定位的数据脚本路径 */
function userHasAnyColumnMasks(user) {
  const data = readStore();
  if (!data || isUserDenied(user)) return false;
  return (data.roleColumns ?? []).some(row => user.roles.includes(row.role_id));
}

function getUserColumnMaskRules(user, conid, database) {
  const data = readStore();
  if (!data || isUserDenied(user)) return [];
  const rows = (data.roleColumns ?? []).filter(row => {
    if (!user.roles.includes(row.role_id)) return false;
    if (row.connection_id && row.connection_id !== conid) return false;
    if (row.database_names_list) {
      const items = String(row.database_names_list)
        .split(/[,\s]+/)
        .map(x => x.trim().toLowerCase())
        .filter(Boolean);
      if (!items.includes(String(database ?? '').toLowerCase())) return false;
    }
    return true;
  });
  return buildColumnMaskRules(rows);
}

function listRoleRowFilters(roleId = null) {
  const data = readStore();
  if (!data) return [];
  return (data.roleRowFilters ?? []).filter(x => !roleId || x.role_id === roleId);
}

function saveRoleRowFilter(row) {
  const data = readStore();
  if (!data) throw new Error('DBGM-00000 Permission store is not initialized');
  if (!row.role_id) throw new Error('DBGM-00000 role_id is required');
  if (!String(row.column_name ?? '').trim()) throw new Error('DBGM-00000 Row filter column is required');
  if (!ALLOWED_OPERATORS.includes(row.filter_operator ?? '=')) {
    throw new Error('DBGM-00000 Unsupported row filter operator');
  }
  if (!VALUE_TYPES.includes(row.value_type ?? 'user')) {
    throw new Error('DBGM-00000 Unsupported row filter value type');
  }
  if ((row.value_type ?? 'user') === 'user' && !ALLOWED_USER_FIELDS.includes(row.user_field)) {
    throw new Error('DBGM-00000 Unknown row filter variable');
  }
  data.roleRowFilters = data.roleRowFilters ?? [];
  const item = {
    id: row.id || nextId('rf', data.roleRowFilters),
    role_id: row.role_id,
    connection_id: row.connection_id ?? '',
    database_names_list: row.database_names_list ?? '',
    table_names_list: row.table_names_list ?? '',
    column_name: String(row.column_name).trim(),
    filter_operator: row.filter_operator ?? '=',
    value_type: row.value_type ?? 'user',
    user_field: (row.value_type ?? 'user') === 'user' ? row.user_field : '',
    filter_value: (row.value_type ?? 'user') === 'literal' ? String(row.filter_value ?? '') : '',
  };
  const index = data.roleRowFilters.findIndex(x => x.id === item.id);
  if (index >= 0) data.roleRowFilters[index] = item;
  else data.roleRowFilters.push(item);
  writeStore(data);
  return item;
}

function deleteRoleRowFilter(rowId) {
  const data = readStore();
  if (!data) return false;
  data.roleRowFilters = data.roleRowFilters ?? [];
  const before = data.roleRowFilters.length;
  data.roleRowFilters = data.roleRowFilters.filter(x => x.id !== rowId);
  if (data.roleRowFilters.length === before) return false;
  writeStore(data);
  return true;
}

/**
 * 某个成员在 (conid, database) 上生效的行级过滤规则。
 * 只取「成员角色里、连接与库都命中」的行；表留空 = 匹配任意表。
 */
function getUserRowFilterRules(user, conid, database) {
  const data = readStore();
  if (!data || isUserDenied(user)) return [];
  const rows = (data.roleRowFilters ?? []).filter(row => {
    if (!user.roles.includes(row.role_id)) return false;
    if (row.connection_id && row.connection_id !== conid) return false;
    if (row.database_names_list) {
      const items = String(row.database_names_list)
        .split(/[,\s]+/)
        .map(x => x.trim().toLowerCase())
        .filter(Boolean);
      if (!items.includes(String(database ?? '').toLowerCase())) return false;
    }
    return true;
  });
  return buildRowFilterRules(rows);
}

// ---------------------------------------------------------------- 使用限制

const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

function parseAllowedHours(text) {
  const match = String(text ?? '').match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (!match) return null;
  const toMinutes = value => {
    const m = value.match(TIME_PATTERN);
    if (!m) return null;
    const hours = Number(m[1]);
    const minutes = Number(m[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  };
  const from = toMinutes(match[1]);
  const to = toMinutes(match[2]);
  if (from === null || to === null) return null;
  return { from, to };
}

function isWithinAllowedHours(allowedHours, date = new Date()) {
  const window = parseAllowedHours(allowedHours);
  if (!window) return true; // 没配或写错 → 不限制（不因为一个笔误把整组成员锁在外面）
  const now = date.getHours() * 60 + date.getMinutes();
  if (window.from <= window.to) return now >= window.from && now <= window.to;
  // 跨零点，例如 22:00-06:00
  return now >= window.from || now <= window.to;
}

function isAllowedIp(allowedIps, ip) {
  const list = String(allowedIps ?? '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
  if (!list.length) return true;
  const normalized = String(ip ?? '').replace(/^::ffff:/, '');
  return list.some(entry => normalized === entry || normalized.startsWith(entry));
}

/**
 * 成员的使用限制 = 各角色的"最严"合并：
 * 行数/超时取最小非零值；时段/IP 是名单，任一角色不允许就不允许。
 */
function getUserLimits(user, roles = null) {
  const data = readStore();
  if (!data || isUserDenied(user)) {
    return { maxRows: 0, timeoutSeconds: 0, allowedHoursList: [], allowedIpsList: [] };
  }
  const own = (roles ?? data.roles.map(normalizeRole)).filter(r => user.roles.includes(r.id));
  const mins = valueOf => {
    const values = own.map(r => valueOf(r.limits ?? {})).filter(x => x > 0);
    return values.length ? Math.min(...values) : 0;
  };
  return {
    maxRows: mins(l => l.maxRows),
    timeoutSeconds: mins(l => l.timeoutSeconds),
    allowedHoursList: own.map(r => r.limits?.allowedHours).filter(Boolean),
    allowedIpsList: own.map(r => r.limits?.allowedIps).filter(Boolean),
  };
}

/** 在给定时间/来源 IP 下，这个成员是否被允许发起请求 */
function checkUserLimits(user, { ip, date = new Date() } = {}) {
  const limits = getUserLimits(user);
  for (const allowedHours of limits.allowedHoursList) {
    if (!isWithinAllowedHours(allowedHours, date)) {
      return { allowed: false, reason: 'outsideAllowedHours', allowedHours };
    }
  }
  for (const allowedIps of limits.allowedIpsList) {
    if (!isAllowedIp(allowedIps, ip)) {
      return { allowed: false, reason: 'ipNotAllowed', allowedIps, ip };
    }
  }
  return { allowed: true, limits };
}

// ---------------------------------------------------------------- 个人授权（v2）

// v2 的界面只讲「成员 → 可见哪些库 → 在该库能做什么」，不讲角色。
// 实现上给成员自动维护一个"个人角色"，把库级规则/操作/限制写进去 ——
// 这样权限判定引擎、矩阵、预览、既有 E2E 全部不用改（个人角色就是普通角色）。

const PERSONAL_ROLE_PREFIX = 'personal-';

function personalRoleId(user) {
  return `${PERSONAL_ROLE_PREFIX}${user.id}`;
}

function findPersonalRole(user) {
  const data = readStore();
  if (!data) return null;
  return data.roles.find(r => r.id === personalRoleId(user)) ?? null;
}

/** 取（必要时创建）成员的个人角色 */
function ensurePersonalRole(user) {
  const data = readStore();
  if (!data) throw new Error('DBGM-00000 Permission store is not initialized');
  const id = personalRoleId(user);
  let role = data.roles.find(r => r.id === id);
  let changed = false;
  if (!role) {
    role = {
      id,
      name: `${user.name || user.login}（个人授权）`,
      builtin: false,
      auto: true,
      personal: true,
      description: '由「成员授权」自动维护，请勿手工编辑',
      permissions: [],
      connections: { all: false, ids: [] },
    };
    data.roles.push(role);
    changed = true;
  }
  // ★ 成员必须真的拥有这个角色：权限引擎（rolesOfUser / grantedConnections）是按
  //   user.roles 取角色的，只建角色不加入成员 → 个人授权完全不生效。
  const member = data.users.find(u => u.id === user.id || u.login === user.login);
  if (member && !(member.roles ?? []).includes(id)) {
    member.roles = [...(member.roles ?? []), id];
    changed = true;
  }
  if (changed) writeStore(data);
  return normalizeRole(role);
}

/** 界面渲染用：这个成员"自己"被授了什么（不含角色模板带来的权限） */
/** 个人角色的连接授权 = 它所有库规则涉及的连接（写进 roleConnections，引擎按它判定） */
function syncPersonalRoleConnections(roleId, data) {
  const conids = [...new Set((data.roleDatabases ?? []).filter(r => r.role_id === roleId).map(r => r.connection_id))];
  data.roleConnections = (data.roleConnections ?? []).filter(r => r.role_id !== roleId);
  for (const connection_id of conids) {
    data.roleConnections.push({ id: nextId('rc', data.roleConnections), role_id: roleId, connection_id });
  }
  writeStore(data);
}

function getMemberGrants(user) {
  const data = readStore();
  const empty = { scope: [], operations: [], limits: normalizeLimits({}), personalRoleId: null };
  if (!data) return empty;
  const id = personalRoleId(user);
  const raw = data.roles.find(r => r.id === id);
  if (!raw) return empty;
  const role = normalizeRole(raw);
  return {
    personalRoleId: id,
    scope: (data.roleDatabases ?? [])
      .filter(row => row.role_id === id)
      .map(row => ({
        ruleId: row.id,
        conid: row.connection_id,
        database: row.database_names_list || row.database_names_regex || '',
        matchAll: !!row.database_names_regex,
        levelId: row.database_permission_role_id,
        level: DATABASE_ROLE_ID_NAMES[row.database_permission_role_id] ?? null,
      })),
    operations: (role.permissions ?? []).filter(p => !String(p).startsWith('~')),
    limits: normalizeLimits(role.limits),
  };
}

/** 写一条成员维度的库级规则（同时确保该连接对他是可见的） */
function saveMemberScope(user, { conid, database, levelId, matchAll }) {
  const data = readStore();
  if (!data) throw new Error('DBGM-00000 Permission store is not initialized');
  const id = personalRoleId(user);
  ensurePersonalRole(user);
  const fresh = readStore();
  const role = fresh.roles.find(r => r.id === id);

  fresh.roleDatabases = fresh.roleDatabases ?? [];
  // matchAll = 该连接的所有库（命令式引擎 Redis 的 DB 0-15 用一条 regex 规则表达）
  let row = fresh.roleDatabases.find(
    r =>
      r.role_id === id &&
      r.connection_id === conid &&
      (matchAll ? r.database_names_regex === '.*' : r.database_names_list === database)
  );
  if (row) {
    row.database_permission_role_id = levelId;
    if (matchAll) {
      row.database_names_regex = '.*';
      row.database_names_list = '';
    }
  } else {
    row = {
      id: nextId('rd', fresh.roleDatabases),
      role_id: id,
      connection_id: conid,
      database_names_list: matchAll ? '' : database,
      database_names_regex: matchAll ? '.*' : '',
      database_permission_role_id: levelId,
    };
    fresh.roleDatabases.push(row);
  }
  writeStore(fresh);
  // ★ 连接可见性必须写进 roleConnections（引擎只认它）；写 role.connections 字段是无效的
  syncPersonalRoleConnections(id, fresh);
  return row;
}

function deleteMemberScope(user, { conid, database, matchAll }) {
  const data = readStore();
  if (!data) return false;
  const id = personalRoleId(user);
  const before = (data.roleDatabases ?? []).length;
  data.roleDatabases = (data.roleDatabases ?? []).filter(
    row =>
      !(
        row.role_id === id &&
        row.connection_id === conid &&
        (matchAll ? row.database_names_regex === '.*' : row.database_names_list === database)
      )
  );
  if (data.roleDatabases.length === before) return false;
  writeStore(data);
  syncPersonalRoleConnections(id, data);
  return true;
}

/** 写成员的操作权限（显式 allow；危险项由基线 deny + 保存时归一共同保证） */
function saveMemberOperations(user, operations) {
  const data = readStore();
  if (!data) throw new Error('DBGM-00000 Permission store is not initialized');
  ensurePersonalRole(user);
  const fresh = readStore();
  const role = fresh.roles.find(r => r.id === personalRoleId(user));
  role.permissions = [...new Set((operations ?? []).map(x => String(x).trim()).filter(Boolean))];
  writeStore(fresh);
  return role.permissions;
}

function saveMemberLimits(user, limits) {
  const data = readStore();
  if (!data) throw new Error('DBGM-00000 Permission store is not initialized');
  ensurePersonalRole(user);
  const fresh = readStore();
  const role = fresh.roles.find(r => r.id === personalRoleId(user));
  role.limits = normalizeLimits(limits);
  writeStore(fresh);
  return role.limits;
}

/**
 * 保存时归一（原型里那条黄条承诺的行为）：
 *   有行级过滤 → 摘掉 run-script（能跑任意 SQL 就绕过了过滤）
 *   有列脱敏   → 摘掉导出类操作（导出通道还没套用脱敏）
 * 返回 { operations, removed[] }，便于界面提示"我们帮你关掉了什么"。
 */
function normalizeOperationsAgainstRestrictions(user, operations) {
  const data = readStore();
  const ops = [...new Set((operations ?? []).map(x => String(x).trim()).filter(Boolean))];
  if (!data) return { operations: ops, removed: [] };
  const roles = (data.roles ?? []).filter(r => (user.roles ?? []).includes(r.id));
  const roleIds = new Set(roles.map(r => r.id));
  const hasRowFilter = (data.roleRowFilters ?? []).some(r => roleIds.has(r.role_id));
  const hasMask = (data.roleColumns ?? []).some(r => roleIds.has(r.role_id));
  const removed = [];
  const out = ops.filter(op => {
    if (op === 'run-script' && hasRowFilter) {
      removed.push({ op, why: 'rowFilter' });
      return false;
    }
    if (op.startsWith('dbops/sql-dump/export') && hasMask) {
      removed.push({ op, why: 'columnMask' });
      return false;
    }
    return true;
  });
  return { operations: out, removed };
}

// ---------------------------------------------------------------- 变更记录（社区版自带，不依赖 Premium 审计）

function appendChangeLog(entry) {
  const data = readStore();
  if (!data) return null;
  const item = {
    id: nextId('cl', data.changeLog ?? []),
    at: new Date().toISOString(),
    actor: entry.actor ?? '',
    target: entry.target ?? '',
    action: entry.action ?? '',
    detail: entry.detail ?? '',
  };
  data.changeLog = [...(data.changeLog ?? []), item].slice(-500); // 只留最近 500 条
  writeStore(data);
  return item;
}

function getChangeLog(limit = 100) {
  const data = readStore();
  if (!data) return [];
  return [...(data.changeLog ?? [])].reverse().slice(0, limit);
}

// ---------------------------------------------------------------- 权限解析

function findUserForLogin(login) {
  if (!login) return null;
  return listUsers().find(u => u.login === login) ?? null;
}

function findUserForConnect({ id, login, email }) {
  if (!id && !login && !email) return null;
  return (
    listUsers().find(u => (id && u.connectUserId === id) || (email && u.email === email)) ??
    listUsers().find(u => login && u.login === login) ??
    null
  );
}

function rolesOfUser(user, roles = listRoles()) {
  return roles.filter(r => user.roles.includes(r.id));
}

function grantedConnections(user, roles = listRoles(), roleConnections = listRoleConnections()) {
  let all = false;
  const ids = new Set();
  for (const role of rolesOfUser(user, roles)) {
    if (role.connections?.all || role.permissions.includes('all-connections')) all = true;
    for (const row of roleConnections) {
      if (row.role_id === role.id && row.connection_id) ids.add(row.connection_id);
    }
  }
  return { all, ids: [...ids] };
}

function envPermissionsFor(login) {
  const perLogin = login ? process.env[`LOGIN_PERMISSIONS_${login}`] : null;
  return perLogin || process.env.PERMISSIONS || '';
}

function isUserDisabled(user) {
  return user?.status === 'disabled';
}

/**
 * 临时账号到期判定。日期解析不出来时按「不过期」处理 ——
 * 配错一个日期不应该把整组成员锁在外面。
 */
function isUserExpired(user, now = Date.now()) {
  const raw = user?.expires;
  if (!raw) return false;
  const text = String(raw).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  // 只写到日的有效期按当天 23:59:59（本地时区）算，而不是 UTC 零点
  const parsed = Date.parse(dateOnly ? `${text}T23:59:59` : text);
  if (!Number.isFinite(parsed)) return false;
  return parsed < now;
}

/** 停用或已过期 —— 两者都必须落到「全拒绝」 */
function isUserDenied(user) {
  if (!user) return true;
  return isUserDisabled(user) || isUserExpired(user);
}

/**
 * 成员的功能权限串 = 团队基线 + 环境变量权限（向后兼容）+ 角色权限 + 连接级授权。
 * 顺序即语义，后面的覆盖前面的。
 */
function buildUserPermissions(user) {
  if (isUserDenied(user)) return [...DENY_ALL_PERMISSIONS];
  const data = readStore();
  if (!data) return [...DENY_ALL_PERMISSIONS];

  const permissions = [...TEAM_BASE_PERMISSIONS];
  const envRaw = envPermissionsFor(user.login);
  if (envRaw)
    permissions.push(
      ...String(envRaw)
        .split(/[,\n]/)
        .map(x => x.trim())
        .filter(Boolean)
    );

  for (const role of rolesOfUser(user, data.roles.map(normalizeRole))) {
    permissions.push(...(role.permissions ?? []));
  }

  const { all, ids } = grantedConnections(user, data.roles.map(normalizeRole), data.roleConnections);
  if (all) {
    // 必须同时给 `connections/*`：连接列表是用 connectionHasPermission() 过滤的，它走的是
    // connections/<conid> 字符串，而不是 all-connections 这个短路标记。
    // 只给 all-connections 会让「有全部连接权限」的人看到一个空列表（E2E 抓到的真 bug）。
    permissions.push('all-connections', 'connections/*');
  } else {
    permissions.push(...ids.map(id => `connections/${id}`));
  }

  return permissions;
}

function getUserDatabasePermissions(user) {
  const data = readStore();
  if (!data || isUserDenied(user)) return [];
  return data.roleDatabases.filter(row => user.roles.includes(row.role_id));
}

function getUserTablePermissions(user) {
  const data = readStore();
  if (!data || isUserDenied(user)) return [];
  return data.roleTables.filter(row => user.roles.includes(row.role_id));
}

/**
 * 某个角色在 (conid, database) 上配的库级规则（用于访问矩阵的可编辑格）。
 * 与引擎一致：同角色内按行顺序，最后一条命中的生效；没命中返回 level=null（继承/无规则）。
 */
function getRoleDatabaseRule(roleId, conid, database) {
  const rows = listRoleDatabases(roleId);
  let hit = null;
  for (const row of rows) {
    const connectionIdentifier = row.connection_id;
    if (connectionIdentifier && connectionIdentifier !== conid) continue;
    if (row.database_names_list) {
      const items = String(row.database_names_list)
        .split('\n')
        .map(x => x.trim().toLowerCase())
        .filter(Boolean);
      if (!items.includes(String(database).toLowerCase())) continue;
    }
    if (row.database_names_regex) {
      let re;
      try {
        re = new RegExp(row.database_names_regex, 'i');
      } catch (err) {
        continue;
      }
      if (!re.test(database)) continue;
    }
    hit = row;
  }
  return {
    ruleId: hit?.id ?? null,
    level: hit ? DATABASE_ROLE_ID_NAMES[hit.database_permission_role_id] ?? null : null,
    row: hit,
  };
}

// ---------------------------------------------------------------- 有效权限预览

function userHasPermission(user, permission) {
  const { compilePermissions, testPermission } = require('dbgate-tools');
  return testPermission(permission, compilePermissions(buildUserPermissions(user)));
}

/**
 * 把某个成员在某个具体目标上的最终权限算出来。
 *
 * 刻意调用 hasPermission.js 里已经导出的解析函数，而不是在存储层再写一份 ——
 * 预览必须与真实判定用同一套规则（懒加载 require 是为了避开
 * permissionStore → hasPermission → authProvider → permissionStore 的循环依赖）。
 *
 * 只传 conid 时不判断具体库；不传 conid 时只返回连接级汇总。
 */
function resolveUserAccess(user, { conid, database, table, objectTypeField = 'tables', schema } = {}) {
  const result = {
    userId: user?.id ?? null,
    login: user?.login ?? null,
    denied: isUserDenied(user),
    disabled: isUserDisabled(user),
    expired: isUserExpired(user),
    databaseLevel: null,
    tableRole: null,
  };

  if (!user || result.denied) {
    result.connectionAllowed = false;
    return result;
  }

  const { all, ids } = grantedConnections(user);
  result.connections = { all, ids };
  if (conid) {
    result.connectionAllowed = all || userHasPermission(user, 'all-connections') || ids.includes(conid);
  }

  if (conid && database) {
    const { getDatabasePermissionRole, getTablePermissionRole } = require('./hasPermission');
    if (userHasPermission(user, 'all-databases')) {
      result.databaseLevel = 'run_script';
      result.viaAllDatabases = true;
    } else {
      result.databaseLevel = getDatabasePermissionRole(conid, database, getUserDatabasePermissions(user));
    }
    result.databaseAllowed = result.databaseLevel !== 'deny';

    if (table) {
      if (userHasPermission(user, 'all-tables')) {
        result.tableRole = 'run_script';
        result.viaAllTables = true;
      } else {
        result.tableRole = getTablePermissionRole(
          conid,
          database,
          objectTypeField,
          schema,
          table,
          getUserTablePermissions(user),
          result.databaseLevel
        );
      }
    }
  }

  return result;
}

/** 给管理界面用的结构化视图：规则、来源角色、到期状态 */
function getUserAccessRules(user) {
  if (!user) return null;
  const data = readStore();
  const roles = data ? rolesOfUser(user, data.roles.map(normalizeRole)) : [];
  const conns = grantedConnections(user);
  return {
    user: normalizeUser(user),
    denied: isUserDenied(user),
    disabled: isUserDisabled(user),
    expired: isUserExpired(user),
    roles: roles.map(r => ({ id: r.id, name: r.name, builtin: !!r.builtin })),
    permissions: buildUserPermissions(user),
    connections: { all: conns.all, ids: conns.ids },
    databaseRules: getUserDatabasePermissions(user).map(row => ({
      ...row,
      database_role: DATABASE_ROLE_ID_NAMES[row.database_permission_role_id] ?? null,
      role_name: (data?.roles.find(r => r.id === row.role_id) || {}).name ?? row.role_id,
    })),
    tableRules: getUserTablePermissions(user).map(row => ({
      ...row,
      table_role: TABLE_ROLE_ID_NAMES[row.table_permission_role_id] ?? null,
      table_scope: TABLE_SCOPE_ID_NAMES[row.table_permission_scope_id] ?? null,
      role_name: (data?.roles.find(r => r.id === row.role_id) || {}).name ?? row.role_id,
    })),
    // 列脱敏与行过滤也要出现在预览里，否则管理员看不到自己配的"更细粒度"到底生效了没有
    columnMasks: (data?.roleColumns ?? [])
      .filter(row => user.roles.includes(row.role_id))
      .map(row => ({
        ...row,
        role_name: (data?.roles.find(r => r.id === row.role_id) || {}).name ?? row.role_id,
      })),
    rowFilters: (data?.roleRowFilters ?? [])
      .filter(row => user.roles.includes(row.role_id))
      .map(row => ({
        ...row,
        role_name: (data?.roles.find(r => r.id === row.role_id) || {}).name ?? row.role_id,
      })),
    // 这两条不是"配置"，而是配置带来的实际后果 —— 管理员最容易踩的两个组合
    restrictions: {
      // 有行过滤的库无法可靠注入裸 SQL，所以裸 SQL / 执行脚本被硬拒
      rawSqlBlocked: (data?.roleRowFilters ?? []).some(row => user.roles.includes(row.role_id)),
      // 列脱敏还没接到流式导出上，所以有脱敏的角色一律不许批量导出
      bulkExportBlocked: (data?.roleColumns ?? []).some(row => user.roles.includes(row.role_id)),
    },
  };
}

/**
 * 把「后来才加进环境变量」的登录补成成员。
 * 引导只在首次启动跑一次，之后往 env 里加人不会自动出现在列表里，用这个补齐。
 * 已有同 login 的成员不动（幂等），也不会覆盖有人在界面上改过的角色。
 */
function importEnvLogins() {
  ensureBootstrap();
  const data = readStore() ?? emptyStore();
  const logins = collectEnvLogins();
  const imported = [];
  const skipped = [];
  for (const login of logins) {
    if (data.users.some(u => u.login === login)) {
      skipped.push(login);
      continue;
    }
    data.users.push(
      normalizeUser({
        id: `u-${login}`,
        login,
        name: login,
        source: '环境变量导入',
        roles: [ROLE_LEGACY],
        status: 'active',
        createdAt: new Date().toISOString(),
      })
    );
    imported.push(login);
  }
  if (imported.length) writeStore(data);
  return { imported, skipped, detected: logins };
}

// ---------------------------------------------------------------- 哆啦A梦

/**
 * SUPER_ADMIN 规则（PLAN §2.4.1）。返回动作名，便于审计与单测：
 *   elevate / revoke / skip
 * - permissions 为空（缺失或查询失败）→ skip：不判定，绝不当成「权限被收回」。
 * - 含 SUPER_ADMIN → 授予超级管理员；已是本地兜底管理员时保留 local 来源，不被自动降级波及。
 * - 不含且来源是 doreamon → 摘掉，只摘这一份。
 */
function applySuperAdminRule(member, permissions) {
  const list = Array.isArray(permissions) ? permissions.filter(x => typeof x === 'string' && x) : [];
  if (!list.length) return 'skip';

  if (list.includes(SUPER_ADMIN_PERMISSION)) {
    if (!member.roles.includes(ROLE_SUPERADMIN)) member.roles.push(ROLE_SUPERADMIN);
    // 已经是本地兜底管理员时保留 local 来源：自动降级不该波及手工授予的那一份
    if (member.superAdminSource !== 'local') member.superAdminSource = 'doreamon';
    return 'elevate';
  }

  if (member.superAdminSource === 'doreamon') {
    member.roles = member.roles.filter(r => r !== ROLE_SUPERADMIN);
    if (!member.roles.length) member.roles = [ROLE_UNASSIGNED];
    member.superAdminSource = null;
    return 'revoke';
  }
  return 'skip';
}

/**
 * 哆啦A梦登录进来时把成员落到本地，并应用 SUPER_ADMIN 规则。
 * 每个请求都会调用，所以只有真的变了（或距上次刷新超过 60s）才落盘。
 */
function upsertConnectMember(connectUser, meta = {}) {
  ensureBootstrap();
  const data = readStore() ?? emptyStore();
  const { id, login, name, email, permissions } = connectUser;
  const resolvedLogin = login || email || id;
  if (!resolvedLogin) return null;

  let member = data.users.find(u => (id && u.connectUserId === id) || (email && u.email === email));
  if (!member) member = data.users.find(u => u.login === resolvedLogin);
  const isNew = !member;
  if (!member) {
    member = normalizeUser({
      id: `u-${resolvedLogin}`,
      login: resolvedLogin,
      name: name || resolvedLogin,
      email: email || '',
      connectUserId: id || '',
      source: '哆啦A梦',
      roles: [ROLE_UNASSIGNED],
      status: 'active',
      createdAt: new Date().toISOString(),
    });
    data.users.push(member);
  }

  const rolesBefore = member.roles.join(',');
  const sourceBefore = member.superAdminSource;
  const action = applySuperAdminRule(member, permissions);
  // action 是「本次判定结论」，changed 才是「本地状态真的变了」——
  // 落盘与否看 changed，避免超级管理员的每个请求都写文件。
  const changed = rolesBefore !== member.roles.join(',') || sourceBefore !== member.superAdminSource;

  const now = Date.now();
  const last = member.lastLogin ? Date.parse(member.lastLogin) : 0;
  if (isNew || changed || now - last > PROFILE_REFRESH_INTERVAL_MS) {
    member.connectUserId = id || member.connectUserId;
    member.email = email || member.email;
    member.name = name || member.name;
    member.source = '哆啦A梦';
    member.lastLogin = new Date(now).toISOString();
    member.lastIp = meta.ip || member.lastIp;
    saveUserRaw(data, member);
    writeStore(data);
  }

  return { user: normalizeUser(member), action, changed, isNew };
}

function getStoreSummary() {
  const data = readStore();
  if (!data) return { initialized: false, users: 0, roles: 0, connections: 0, databases: 0, tables: 0 };
  return {
    initialized: true,
    path: storeFilePath(),
    version: data.version,
    users: data.users.length,
    roles: data.roles.length,
    connections: data.roleConnections.length,
    databases: data.roleDatabases.length,
    tables: data.roleTables.length,
  };
}

module.exports = {
  STORE_VERSION,
  STORE_FILE_NAME,
  TEAM_BASE_PERMISSIONS,
  DENY_ALL_PERMISSIONS,
  ROLE_SUPERADMIN,
  ROLE_UNASSIGNED,
  ROLE_LEGACY,
  SUPER_ADMIN_PERMISSION,
  SUPER_ADMIN_ROLE_ID,
  isConnectAuthEnabled,
  getConnectSecret,
  isPermissionStoreActive,
  refreshBuiltinRoles,
  storeFilePath,
  readStore,
  writeStore,
  emptyStore,
  ensureBootstrap,
  builtinRoles,
  collectEnvLogins,
  importEnvLogins,
  listRoles,
  getRole,
  saveRole,
  deleteRole,
  listUsers,
  getUser,
  saveUser,
  deleteUser,
  listRoleConnections,
  setRoleConnections,
  listRoleDatabases,
  saveRoleDatabase,
  deleteRoleDatabase,
  listRoleTables,
  saveRoleTable,
  deleteRoleTable,
  listRoleColumns,
  saveRoleColumn,
  deleteRoleColumn,
  getUserColumnMaskRules,
  userHasAnyColumnMasks,
  listRoleRowFilters,
  saveRoleRowFilter,
  deleteRoleRowFilter,
  getUserRowFilterRules,
  PERSONAL_ROLE_PREFIX,
  personalRoleId,
  findPersonalRole,
  ensurePersonalRole,
  getMemberGrants,
  saveMemberScope,
  deleteMemberScope,
  saveMemberOperations,
  saveMemberLimits,
  normalizeOperationsAgainstRestrictions,
  appendChangeLog,
  getChangeLog,
  parseAllowedHours,
  isWithinAllowedHours,
  isAllowedIp,
  getUserLimits,
  checkUserLimits,
  findUserForLogin,
  findUserForConnect,
  grantedConnections,
  buildUserPermissions,
  getUserDatabasePermissions,
  getUserTablePermissions,
  isUserDisabled,
  isUserExpired,
  isUserDenied,
  userHasPermission,
  resolveUserAccess,
  getUserAccessRules,
  getRoleDatabaseRule,
  applySuperAdminRule,
  upsertConnectMember,
  getStoreSummary,
};
