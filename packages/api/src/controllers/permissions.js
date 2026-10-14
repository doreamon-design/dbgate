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
const { sendToAuditLog } = require('../utility/auditlog');
const store = require('../utility/permissionStore');
const {
  DATABASE_ROLE_ID_NAMES,
  DATABASE_ROLE_NAME_IDS,
  TABLE_ROLE_ID_NAMES,
  TABLE_SCOPE_ID_NAMES,
  DATABASE_ROLE_ORDER,
  TABLE_ROLE_ORDER,
} = require('../utility/permissionLevels');
const { getOperationPermissions } = require('../utility/operationPermissions');
const { MASK_MODES } = require('../utility/columnMasking');
const { ALLOWED_USER_FIELDS, ALLOWED_OPERATORS, VALUE_TYPES } = require('../utility/rowFiltering');

const logger = getLogger('permissions');

const PERMISSION_USERS = 'admin/users';
const PERMISSION_ROLES = 'admin/roles';

// 矩阵一次最多解析这么多成员，避免有人拿它当批量接口刷
const MAX_MATRIX_USERS = 100;

// 预览可见性时的上限，避免一次把几十个库的结构都拉出来
const MAX_VISIBILITY_CONNECTIONS = 5;
const MAX_VISIBILITY_DATABASES = 20;
const MAX_VISIBILITY_TABLES = 200;

function isHttpRequest(req) {
  return !!req;
}

// community 版 sendToAuditLog 是空实现；接了 Team(Premium) 之后这些事件会自动出现在
// 管理端审计日志里（审计后端在 Premium 侧），所以这里照常发，不做本地兜底存储。
function auditPermissionChange(req, action, message, severity = 'info') {
  sendToAuditLog(req, {
    category: 'permissions',
    component: 'PermissionsController',
    action,
    event: `permissions.${action}`,
    severity,
    message,
  });
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
    return {
      ...store.getStoreSummary(),
      // 让「登录 / 成员来源」页显示真实状态，而不是写死的说明文字
      connectAuth: {
        enabled: store.isConnectAuthEnabled(),
        hasSecret: !!store.getConnectSecret(),
        logoutUrl: process.env.CONNECT_LOGOUT_URL || null,
      },
      superAdminPermission: store.SUPER_ADMIN_PERMISSION,
    };
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
      // 操作开关：清单里每一项都有真实强制点，见 operationPermissions.test.js
      operationPermissions: getOperationPermissions(),
      columnMaskModes: MASK_MODES,
      rowFilterUserFields: ALLOWED_USER_FIELDS,
      rowFilterOperators: ALLOWED_OPERATORS,
      rowFilterValueTypes: VALUE_TYPES,
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
    auditPermissionChange(req, 'user.save', `Saved member ${saved.login} (roles: ${saved.roles.join(', ')})`);
    return { user: saved };
  },

  deleteUser_meta: true,
  async deleteUser({ userId }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_USERS, req);
    const deleted = store.deleteUser(userId);
    if (deleted) auditPermissionChange(req, 'user.delete', `Deleted member ${userId}`, 'warning');
    return { deleted };
  },

  importEnvUsers_meta: true,
  async importEnvUsers(_params, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_USERS, req);
    const res = store.importEnvLogins();
    if (res.imported.length) auditPermissionChange(req, 'user.importEnv', `Imported ${res.imported.length} env login(s): ${res.imported.join(', ')}`);
    return res;
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
      columns: store.listRoleColumns(roleId),
      rowFilters: store.listRoleRowFilters(roleId),
    };
  },

  saveRoleDetail_meta: true,
  async saveRoleDetail({ role, connections, databases, tables, columns, rowFilters }, req) {
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
    if (Array.isArray(columns)) {
      for (const row of store.listRoleColumns(saved.id)) store.deleteRoleColumn(row.id);
      for (const row of columns) store.saveRoleColumn({ ...row, role_id: saved.id });
    }
    if (Array.isArray(rowFilters)) {
      for (const row of store.listRoleRowFilters(saved.id)) store.deleteRoleRowFilter(row.id);
      for (const row of rowFilters) store.saveRoleRowFilter({ ...row, role_id: saved.id });
    }
    auditPermissionChange(
      req,
      'role.save',
      `Saved role ${saved.name} (${databases?.length ?? 0} database rules, ${tables?.length ?? 0} object rules)`
    );
    return this.getRoleDetail({ roleId: saved.id }, null);
  },

  deleteRole_meta: true,
  async deleteRole({ roleId }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    const deleted = store.deleteRole(roleId);
    if (deleted) auditPermissionChange(req, 'role.delete', `Deleted role ${roleId}`, 'warning');
    return { deleted };
  },

  // ------------------------------------------------------------ 授权（细粒度，供访问矩阵单格修改）

  saveRoleDatabase_meta: true,
  async saveRoleDatabase(row, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    const saved = store.saveRoleDatabase(row);
    auditPermissionChange(
      req,
      'grant.database',
      `Role ${saved.role_id}: ${saved.connection_id}/${saved.database_names_list || saved.database_names_regex} → ${
        DATABASE_ROLE_ID_NAMES[saved.database_permission_role_id]
      }`
    );
    return { row: saved };
  },

  deleteRoleDatabase_meta: true,
  async deleteRoleDatabase({ rowId }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    const deleted = store.deleteRoleDatabase(rowId);
    if (deleted) auditPermissionChange(req, 'grant.database.delete', `Removed database rule ${rowId}`, 'warning');
    return { deleted };
  },

  saveRoleTable_meta: true,
  async saveRoleTable(row, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    const saved = store.saveRoleTable(row);
    auditPermissionChange(
      req,
      'grant.table',
      `Role ${saved.role_id}: ${saved.connection_id}/${saved.database_names_list}:${saved.table_names_list} → ${
        TABLE_ROLE_ID_NAMES[saved.table_permission_role_id]
      }`
    );
    return { row: saved };
  },

  deleteRoleTable_meta: true,
  async deleteRoleTable({ rowId }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    const deleted = store.deleteRoleTable(rowId);
    if (deleted) auditPermissionChange(req, 'grant.table.delete', `Removed object rule ${rowId}`, 'warning');
    return { deleted };
  },

  saveRoleRowFilter_meta: true,
  async saveRoleRowFilter(row, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    const saved = store.saveRoleRowFilter(row);
    auditPermissionChange(
      req,
      'grant.rowFilter',
      `Role ${saved.role_id}: ${saved.connection_id}/${saved.database_names_list}:${saved.table_names_list} ${saved.column_name} ${saved.filter_operator} ${saved.value_type === 'user' ? 'user.' + saved.user_field : saved.filter_value}`
    );
    return { row: saved };
  },

  deleteRoleRowFilter_meta: true,
  async deleteRoleRowFilter({ rowId }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    const deleted = store.deleteRoleRowFilter(rowId);
    if (deleted) auditPermissionChange(req, 'grant.rowFilter.delete', `Removed row filter ${rowId}`, 'warning');
    return { deleted };
  },

  saveRoleColumn_meta: true,
  async saveRoleColumn(row, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    const saved = store.saveRoleColumn(row);
    auditPermissionChange(
      req,
      'grant.column',
      `Role ${saved.role_id}: ${saved.connection_id}/${saved.database_names_list}:${saved.table_names_list}.${saved.column_names_list} → ${saved.column_mask_mode}`
    );
    return { row: saved };
  },

  deleteRoleColumn_meta: true,
  async deleteRoleColumn({ rowId }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    const deleted = store.deleteRoleColumn(rowId);
    if (deleted) auditPermissionChange(req, 'grant.column.delete', `Removed column mask ${rowId}`, 'warning');
    return { deleted };
  },

  setRoleConnections_meta: true,
  async setRoleConnections({ roleId, connectionIds }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_ROLES, req);
    const connections = store.setRoleConnections(roleId, connectionIds ?? []);
    auditPermissionChange(req, 'grant.connections', `Role ${roleId}: connections = ${connectionIds?.join(', ') || '(none)'}`);
    return { connections };
  },

  // ------------------------------------------------------------ 有效权限预览

  getUserAccess_meta: true,
  async getUserAccess({ userId }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_USERS, req);
    const user = store.getUser(userId);
    if (!user) throw new Error(`DBGM-00000 User "${userId}" not found`);
    return store.getUserAccessRules(user);
  },

  /**
   * 以某个成员的身份"看一遍他看到的树"（严格只读）。
   *
   * 安全设计：不切换凭据 —— 数据库调用全程用**管理员自己的**身份执行（管理员本来就有权限），
   * 只是把结果按该成员的规则过滤一遍。所以这不会给管理员多出任何他本来没有的访问能力，
   * 也不会产生任何写操作。
   */
  getUserVisibility_meta: true,
  async getUserVisibility({ userId, conid }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_USERS, req);
    const user = store.getUser(userId);
    if (!user) throw new Error(`DBGM-00000 User "${userId}" not found`);

    const granted = store.grantedConnections(user);
    const connectionsController = require('./connections');
    const serverConnections = require('./serverConnections');
    const databaseConnections = require('./databaseConnections');

    const skipReasons = [];
    let ownConnections = [];
    try {
      ownConnections = (await connectionsController.list({}, req)) ?? [];
    } catch (err) {
      skipReasons.push({ reason: 'Could not list connections', detail: err.message });
    }

    const allowed = ownConnections.filter(c => granted.all || granted.ids.includes(c._id));
    const selected = conid ? allowed.filter(c => c._id === conid) : allowed.slice(0, MAX_VISIBILITY_CONNECTIONS);

    const result = [];
    for (const connection of selected) {
      const conid2 = connection._id;
      const entry = {
        conid: conid2,
        name: connection.displayName || connection.name || conid2,
        engine: connection.engine,
        databases: [],
      };
      let databaseNames = [];
      try {
        const dbs = await serverConnections.listDatabases({ conid: conid2 }, req);
        databaseNames = (dbs ?? []).map(x => x.name);
      } catch (err) {
        entry.error = err.message;
      }
      if (!databaseNames.length && connection.defaultDatabase) databaseNames = [connection.defaultDatabase];

      for (const database of databaseNames.slice(0, MAX_VISIBILITY_DATABASES)) {
        const access = store.resolveUserAccess(user, { conid: conid2, database });
        if (!access.databaseAllowed) continue;

        const dbEntry = { name: database, level: access.databaseLevel, tables: [] };
        try {
          const structure = await databaseConnections.structure({ conid: conid2, database }, req);
          const masks = store.getUserColumnMaskRules(user, conid2, database);
          const filters = store.getUserRowFilterRules(user, conid2, database);
          for (const table of (structure?.tables ?? []).slice(0, MAX_VISIBILITY_TABLES)) {
            const tableAccess = store.resolveUserAccess(user, {
              conid: conid2,
              database,
              table: table.pureName,
              objectTypeField: 'tables',
              schema: table.schemaName,
            });
            if (tableAccess.tableRole === 'deny') continue;
            const tableMasks = masks.filter(m => !m.table || String(m.table).toLowerCase() === String(table.pureName).toLowerCase());
            const tableFilters = filters.filter(
              f => !f.table || String(f.table).toLowerCase() === String(table.pureName).toLowerCase()
            );
            dbEntry.tables.push({
              name: table.pureName,
              schemaName: table.schemaName,
              role: tableAccess.tableRole,
              maskedColumns: tableMasks.map(m => ({ column: m.column, mode: m.mode })),
              rowFiltered: tableFilters.length > 0,
            });
          }
        } catch (err) {
          dbEntry.error = err.message;
        }
        entry.databases.push(dbEntry);
      }
      result.push(entry);
    }

    return {
      user: { id: user.id, login: user.login, name: user.name },
      denied: store.isUserDenied(user),
      connections: result,
      truncated: allowed.length > selected.length,
      skipReasons,
    };
  },

  // 逐个目标解析最终权限：{ conid, database, table, objectTypeField, schema }
  resolveAccess_meta: true,
  async resolveAccess({ userId, conid, database, table, objectTypeField, schema }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_USERS, req);
    const user = store.getUser(userId);
    if (!user) throw new Error(`DBGM-00000 User "${userId}" not found`);
    return store.resolveUserAccess(user, { conid, database, table, objectTypeField, schema });
  },

  // 访问矩阵的一整屏数据：角色列（可编辑）+ 成员列（只读的最终档位）
  getAccessMatrix_meta: true,
  async getAccessMatrix({ conid, database, userIds }, req) {
    if (isHttpRequest(req)) await testStandardPermission(PERMISSION_USERS, req);
    if (!conid || !database) return { conid: conid ?? null, database: database ?? null, roles: [], users: [] };

    const roleList = store.listRoles();
    const ids = [...new Set(userIds ?? [])].slice(0, MAX_MATRIX_USERS);

    return {
      conid,
      database,
      roles: roleList.map(role => {
        const { level, ruleId } = store.getRoleDatabaseRule(role.id, conid, database);
        return {
          id: role.id,
          name: role.name,
          builtin: !!role.builtin,
          // null 表示该角色在这个库上没有显式规则（矩阵里显示「继承/无规则」）
          level,
          levelId: level ? DATABASE_ROLE_NAME_IDS[level] : null,
          ruleId,
          memberCount: store.listUsers().filter(u => u.roles.includes(role.id)).length,
        };
      }),
      users: ids.map(userId => {
        const user = store.getUser(userId);
        if (!user) return { userId, login: null, name: null, level: 'deny', denied: true, missing: true };
        const resolved = store.resolveUserAccess(user, { conid, database });
        return {
          userId,
          login: user.login,
          name: user.name,
          level: resolved.databaseLevel,
          connectionAllowed: resolved.connectionAllowed,
          denied: resolved.denied,
          expired: resolved.expired,
          disabled: resolved.disabled,
          roles: user.roles,
        };
      }),
    };
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
        // 文件型引擎（sqlite/duckdb）不实现 listDatabases，访问矩阵要靠这个字段拿到库名
        singleDatabase: !!c.singleDatabase,
        defaultDatabase: c.defaultDatabase ?? null,
      })),
    };
  },
};
