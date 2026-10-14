const { compilePermissions, testPermission, getPermissionsCacheKey } = require('dbgate-tools');
const _ = require('lodash');
const { getAuthProviderFromReq } = require('../auth/authProvider');
const { isPermissionStoreActive } = require('./permissionStore');
const {
  DATABASE_ROLE_ID_NAMES,
  TABLE_ROLE_ID_NAMES,
  TABLE_SCOPE_ID_NAMES,
} = require('./permissionLevels');

const cachedPermissions = {};

async function loadPermissionsFromRequest(req) {
  const authProvider = getAuthProviderFromReq(req);
  if (!req) {
    return null;
  }

  const loadedPermissions = await authProvider.getCurrentPermissions(req);
  return loadedPermissions;
}

function hasPermission(tested, loadedPermissions) {
  if (!loadedPermissions) {
    // not available, allow all
    return true;
  }

  const permissionsKey = getPermissionsCacheKey(loadedPermissions);
  if (!cachedPermissions[permissionsKey]) {
    cachedPermissions[permissionsKey] = compilePermissions(loadedPermissions);
  }

  return testPermission(tested, cachedPermissions[permissionsKey]);
}

function connectionHasPermission(connection, loadedPermissions) {
  if (!connection) {
    return true;
  }
  if (_.isString(connection)) {
    return hasPermission(`connections/${connection}`, loadedPermissions);
  } else {
    return hasPermission(`connections/${connection._id}`, loadedPermissions);
  }
}

async function testConnectionPermission(connection, req, loadedPermissions) {
  if (!loadedPermissions) {
    loadedPermissions = await loadPermissionsFromRequest(req);
  }
  if (isPermissionStoreActive()) {
    if (hasPermission(`all-connections`, loadedPermissions)) {
      return;
    }
    const conid = _.isString(connection) ? connection : connection?._id;
    if (hasPermission('internal-storage', loadedPermissions) && conid == '__storage') {
      return;
    }
    if (!req) {
      return;
    }
    // 存储生效时先问 provider（它知道逐条连接授权）；社区版的 provider 只会
    // 把授权表达成 permissions 里的 connections/<conid>，所以再兜一次字符串判定。
    const authProvider = getAuthProviderFromReq(req);
    const allowedByProvider = await authProvider.checkCurrentConnectionPermission(req, conid);
    if (!allowedByProvider && !connectionHasPermission(connection, loadedPermissions)) {
      throw new Error('DBGM-00263 Connection permission not granted');
    }
  } else {
    if (!connectionHasPermission(connection, loadedPermissions)) {
      throw new Error('DBGM-00264 Connection permission not granted');
    }
  }
}

async function loadDatabasePermissionsFromRequest(req) {
  const authProvider = getAuthProviderFromReq(req);
  if (!req) {
    return null;
  }

  const databasePermissions = await authProvider.getCurrentDatabasePermissions(req);
  return databasePermissions;
}

async function loadTablePermissionsFromRequest(req) {
  const authProvider = getAuthProviderFromReq(req);
  if (!req) {
    return null;
  }

  const tablePermissions = await authProvider.getCurrentTablePermissions(req);
  return tablePermissions;
}

async function loadFilePermissionsFromRequest(req) {
  const authProvider = getAuthProviderFromReq(req);
  if (!req) {
    return null;
  }

  const filePermissions = await authProvider.getCurrentFilePermissions(req);
  return filePermissions;
}

/**
 * 当前请求在 (conid, database) 上要应用的列脱敏规则。
 * 走 provider 而不是直接查存储：provider 是唯一知道「请求 → 成员」映射的地方，
 * 这样 env 登录/管理员密码登录的成员也能拿到自己的规则。
 */
/**
 * 当前请求在 (conid, database) 上要应用的行级过滤：{ rules, user }。
 * rules 为空 = 不做行过滤（同时也就允许裸 SQL，见 testDatabaseRolePermission 的互斥守卫）。
 */
async function loadRowFilterContext(req, conid, database) {
  if (!req || !isPermissionStoreActive()) return { rules: [], user: null };
  const authProvider = getAuthProviderFromReq(req);
  if (typeof authProvider.getCurrentRowFilterContext !== 'function') return { rules: [], user: null };
  return (await authProvider.getCurrentRowFilterContext(req, conid, database)) ?? { rules: [], user: null };
}

async function loadColumnMaskRules(req, conid, database) {
  if (!req || !isPermissionStoreActive()) return [];
  const authProvider = getAuthProviderFromReq(req);
  if (typeof authProvider.getCurrentColumnMaskRules !== 'function') return [];
  return (await authProvider.getCurrentColumnMaskRules(req, conid, database)) ?? [];
}

function matchDatabasePermissionRow(conid, database, permissionRow) {
  const connectionIdentifier = permissionRow.connection_conid ?? permissionRow.connection_id;
  if (connectionIdentifier) {
    if (conid != connectionIdentifier) {
      return false;
    }
  }
  if (permissionRow.database_names_list) {
    const items = permissionRow.database_names_list.split('\n');
    if (!items.find(item => item.trim()?.toLowerCase() === database?.toLowerCase())) {
      return false;
    }
  }
  if (permissionRow.database_names_regex) {
    const regex = new RegExp(permissionRow.database_names_regex, 'i');
    if (!regex.test(database)) {
      return false;
    }
  }
  return true;
}

function matchTablePermissionRow(objectTypeField, schemaName, pureName, permissionRow) {
  if (permissionRow.table_names_list) {
    const items = permissionRow.table_names_list.split('\n');
    if (!items.find(item => item.trim()?.toLowerCase() === pureName?.toLowerCase())) {
      return false;
    }
  }
  if (permissionRow.table_names_regex) {
    const regex = new RegExp(permissionRow.table_names_regex, 'i');
    if (!regex.test(pureName)) {
      return false;
    }
  }
  if (permissionRow.schema_names_list) {
    const items = permissionRow.schema_names_list.split('\n');
    if (!items.find(item => item.trim()?.toLowerCase() === schemaName?.toLowerCase())) {
      return false;
    }
  }
  if (permissionRow.schema_names_regex) {
    const regex = new RegExp(permissionRow.schema_names_regex, 'i');
    if (!regex.test(schemaName)) {
      return false;
    }
  }

  return true;
}

function matchFilePermissionRow(folder, file, permissionRow) {
  if (permissionRow.folder_name) {
    if (folder != permissionRow.folder_name) {
      return false;
    }
  }
  if (permissionRow.file_names_list) {
    const items = permissionRow.file_names_list.split('\n');
    if (!items.find(item => item.trim()?.toLowerCase() === file?.toLowerCase())) {
      return false;
    }
  }
  if (permissionRow.file_names_regex) {
    const regex = new RegExp(permissionRow.file_names_regex, 'i');
    if (!regex.test(file)) {
      return false;
    }
  }
  return true;
}

const FILE_ROLE_ID_NAMES = {
  '-1': 'allow',
  '-2': 'deny',
};

function getDatabaseRoleLevelIndex(roleName) {
  if (!roleName) {
    return 6;
  }
  if (roleName == 'run_script') {
    return 5;
  }
  if (roleName == 'write_data') {
    return 4;
  }
  if (roleName == 'read_content') {
    return 3;
  }
  if (roleName == 'view') {
    return 2;
  }
  if (roleName == 'deny') {
    return 1;
  }
  return 6;
}

function getTablePermissionRoleLevelIndex(roleName) {
  if (!roleName) {
    return 6;
  }
  if (roleName == 'run_script') {
    return 5;
  }
  if (roleName == 'create_update_delete') {
    return 4;
  }
  if (roleName == 'update_only') {
    return 3;
  }
  if (roleName == 'read') {
    return 2;
  }
  if (roleName == 'deny') {
    return 1;
  }
  return 6;
}

function getDatabasePermissionRole(conid, database, loadedDatabasePermissions) {
  let res = 'deny';
  for (const permissionRow of loadedDatabasePermissions) {
    if (!matchDatabasePermissionRow(conid, database, permissionRow)) {
      continue;
    }
    res = DATABASE_ROLE_ID_NAMES[permissionRow.database_permission_role_id];
  }
  return res;
}

function getFilePermissionRole(folder, file, loadedFilePermissions) {
  let res = 'deny';
  for (const permissionRow of loadedFilePermissions) {
    if (!matchFilePermissionRow(folder, file, permissionRow)) {
      continue;
    }
    res = FILE_ROLE_ID_NAMES[permissionRow.file_permission_role_id];
  }
  return res;
}

function getTablePermissionRole(
  conid,
  database,
  objectTypeField,
  schemaName,
  pureName,
  loadedTablePermissions,
  databasePermissionRole
) {
  let res =
    databasePermissionRole == 'read_content'
      ? 'read'
      : databasePermissionRole == 'write_data'
      ? 'create_update_delete'
      : databasePermissionRole == 'run_script'
      ? 'run_script'
      : 'deny';
  for (const permissionRow of loadedTablePermissions) {
    if (!matchDatabasePermissionRow(conid, database, permissionRow)) {
      continue;
    }
    if (!matchTablePermissionRow(objectTypeField, schemaName, pureName, permissionRow)) {
      continue;
    }
    const scope = TABLE_SCOPE_ID_NAMES[permissionRow.table_permission_scope_id];
    switch (scope) {
      case 'tables':
        if (objectTypeField != 'tables') continue;
        break;
      case 'views':
        if (objectTypeField != 'views') continue;
        break;
      case 'tables_views_collections':
        if (objectTypeField != 'tables' && objectTypeField != 'views' && objectTypeField != 'collections') continue;
        break;
      case 'procedures':
        if (objectTypeField != 'procedures') continue;
        break;
      case 'functions':
        if (objectTypeField != 'functions') continue;
        break;
      case 'triggers':
        if (objectTypeField != 'triggers') continue;
        break;
      case 'sql_objects':
        if (objectTypeField != 'procedures' && objectTypeField != 'functions' && objectTypeField != 'triggers')
          continue;
        break;
      case 'collections':
        if (objectTypeField != 'collections') continue;
        break;
    }
    res = TABLE_ROLE_ID_NAMES[permissionRow.table_permission_role_id];
  }
  return res;
}

async function testStandardPermission(permission, req, loadedPermissions) {
  if (!loadedPermissions) {
    loadedPermissions = await loadPermissionsFromRequest(req);
  }
  if (!hasPermission(permission, loadedPermissions)) {
    throw new Error(`DBGM-00265 Permission ${permission} not granted`);
  }
}

async function testDatabaseRolePermission(conid, database, requiredRole, req) {
  if (!isPermissionStoreActive()) {
    return;
  }
  // ★ 用户的决策：配了行级过滤的库强制关掉「执行脚本」档位。
  // 能跑任意 SQL 就能绕开 WHERE 注入，所以这里必须是硬互斥，而不是界面上的一句提示。
  if (requiredRole == 'run_script') {
    const { rules } = await loadRowFilterContext(req, conid, database);
    if (rules.length) {
      throw new Error(
        'DBGM-00000 Row filters are configured for this database; running raw scripts bypasses them and is therefore refused'
      );
    }
  }
  const loadedPermissions = await loadPermissionsFromRequest(req);
  if (hasPermission(`all-databases`, loadedPermissions)) {
    return;
  }
  const databasePermissions = await loadDatabasePermissionsFromRequest(req);
  const role = getDatabasePermissionRole(conid, database, databasePermissions);
  const requiredIndex = getDatabaseRoleLevelIndex(requiredRole);
  const roleIndex = getDatabaseRoleLevelIndex(role);
  if (roleIndex < requiredIndex) {
    throw new Error(`DBGM-00266 Permission ${requiredRole} not granted`);
  }
}

module.exports = {
  hasPermission,
  connectionHasPermission,
  testConnectionPermission,
  loadPermissionsFromRequest,
  loadDatabasePermissionsFromRequest,
  loadTablePermissionsFromRequest,
  loadFilePermissionsFromRequest,
  loadColumnMaskRules,
  loadRowFilterContext,
  getDatabasePermissionRole,
  getTablePermissionRole,
  getFilePermissionRole,
  testStandardPermission,
  testDatabaseRolePermission,
  getTablePermissionRoleLevelIndex,
};
