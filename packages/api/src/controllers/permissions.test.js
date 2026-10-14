// 管理端路由的授权回归测试。
//
// 与 Team(Premium) 版 storage.test.js 的「每条暴露出去的路由都必须索要权限」是同一个守卫，
// 但这里不 mock ./storageDb（社区版没有这个模块，那 4 个 Premium 测试文件在本仓跑不起来）。

// 只替换掉要做断言的 testStandardPermission，其余（档位解析函数）保留真实实现：
// permissionStore.resolveUserAccess 复用 hasPermission 的解析器，全量 mock 会把它打掉。
jest.mock('../utility/hasPermission', () => ({
  ...jest.requireActual('../utility/hasPermission'),
  testStandardPermission: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');

const { testStandardPermission } = require('../utility/hasPermission');
const permissions = require('./permissions');
const store = require('../utility/permissionStore');

// route name -> 必须索要的管理端权限
const ROUTE_PERMISSIONS = {
  getSummary: 'admin/users',
  getOptions: 'admin/roles',
  getUserList: 'admin/users',
  getUserDetail: 'admin/users',
  saveUserDetail: 'admin/users',
  deleteUser: 'admin/users',
  getRoleList: 'admin/roles',
  getRoleDetail: 'admin/roles',
  saveRoleDetail: 'admin/roles',
  deleteRole: 'admin/roles',
  saveRoleDatabase: 'admin/roles',
  deleteRoleDatabase: 'admin/roles',
  saveRoleTable: 'admin/roles',
  deleteRoleTable: 'admin/roles',
  setRoleConnections: 'admin/roles',
  getConnectionList: 'admin/roles',
  getUserAccess: 'admin/users',
  resolveAccess: 'admin/users',
};

const fakeRequest = { user: { login: 'low-privilege', userId: 'u-low' } };
let workdir;

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbgate-permsctl-'));
  process.env.WORKSPACE_DIR = workdir;
  jest.clearAllMocks();
  testStandardPermission.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe('route authorization', () => {
  test('every exposed route is permission-gated', () => {
    const exposed = Object.keys(permissions)
      .filter(key => key.endsWith('_meta'))
      .map(key => key.slice(0, -'_meta'.length));
    const ungated = exposed.filter(name => !(name in ROUTE_PERMISSIONS));
    expect(ungated).toEqual([]);
  });

  describe.each(Object.entries(ROUTE_PERMISSIONS))('%s', (route, permission) => {
    test(`demands ${permission} over HTTP`, async () => {
      await permissions[route]({}, fakeRequest).catch(() => {});
      expect(testStandardPermission).toHaveBeenCalledWith(permission, fakeRequest);
    });

    test('refuses the call when the permission is not granted', async () => {
      testStandardPermission.mockRejectedValue(new Error(`DBGM-00265 Permission ${permission} not granted`));
      await expect(permissions[route]({}, fakeRequest)).rejects.toThrow('not granted');
    });

    test('skips the check for in-process calls (no request)', async () => {
      await permissions[route]({}).catch(() => {});
      expect(testStandardPermission).not.toHaveBeenCalled();
    });
  });
});

describe('permission store behind the routes', () => {
  beforeEach(() => {
    permissions._init();
  });

  test('_init bootstraps the store', () => {
    expect(store.isPermissionStoreActive()).toBe(true);
    expect(store.listRoles().map(r => r.id)).toContain(store.ROLE_LEGACY);
  });

  test('user administration round-trips', async () => {
    const role = store.saveRole({ name: '后端开发', permissions: ['widgets/database'] });

    const saved = await permissions.saveUserDetail(
      { user: { login: 'lisi', name: '李四', roles: [role.id], status: 'active' } },
      null
    );
    expect(saved.user.login).toBe('lisi');

    const list = await permissions.getUserList({}, null);
    expect(list.users.map(u => u.login)).toContain('lisi');
    expect(list.roles.map(r => r.id)).toContain(role.id);

    const detail = await permissions.getUserDetail({ userId: saved.user.id }, null);
    expect(detail.user.name).toBe('李四');

    const deleted = await permissions.deleteUser({ userId: saved.user.id }, null);
    expect(deleted.deleted).toBe(true);
  });

  test('role administration round-trips with grants', async () => {
    const role = await permissions.saveRoleDetail(
      {
        role: { name: '报表只读', description: '只读', permissions: ['widgets/database'] },
        connections: { all: false, ids: ['con-prod'] },
        databases: [
          {
            connection_id: 'con-prod',
            database_names_list: 'order_db',
            database_permission_role_id: -2,
          },
        ],
        tables: [
          {
            connection_id: 'con-prod',
            database_names_list: 'order_db',
            table_names_list: 'orders',
            table_permission_role_id: -1,
            table_permission_scope_id: -2,
          },
        ],
      },
      null
    );

    expect(role.connections).toHaveLength(1);
    expect(role.databases).toHaveLength(1);
    expect(role.tables).toHaveLength(1);
    expect(role.role.name).toBe('报表只读');

    const detail = await permissions.getRoleDetail({ roleId: role.role.id }, null);
    expect(detail.databases[0]).toMatchObject({ connection_id: 'con-prod', database_permission_role_id: -2 });
  });

  test('single-cell grant edits work for the access matrix', async () => {
    const role = store.saveRole({ name: '矩阵用' });
    const row = await permissions.saveRoleDatabase(
      { role_id: role.id, connection_id: 'con-prod', database_names_list: 'pay_db', database_role: 'view' },
      null
    );
    expect(row.row.database_permission_role_id).toBe(-1);

    const removed = await permissions.deleteRoleDatabase({ rowId: row.row.id }, null);
    expect(removed.deleted).toBe(true);
    expect(store.listRoleDatabases(role.id)).toHaveLength(0);
  });

  test('getOptions exposes the storageModel level ids to the web UI', async () => {
    const options = await permissions.getOptions({}, null);
    expect(options.databaseRoles.find(x => x.name === 'read_content')).toMatchObject({ id: -2 });
    expect(options.tableScopes.find(x => x.name === 'tables')).toMatchObject({ id: -2 });
    expect(options.builtinRoles.superadmin).toBe(store.ROLE_SUPERADMIN);
    expect(options.superAdminPermission).toBe('SUPER_ADMIN');
  });

  test('getUserAccess returns the structured rules behind a member', async () => {
    const role = store.saveRole({ name: '报表只读' });
    store.setRoleConnections(role.id, ['con-prod']);
    store.saveRoleDatabase({ role_id: role.id, connection_id: 'con-prod', database_names_list: 'order_db', database_role: 'read_content' });
    const saved = store.saveUser({ login: 'wangwu', roles: [role.id] });

    const access = await permissions.getUserAccess({ userId: saved.id }, null);
    expect(access.denied).toBe(false);
    expect(access.connections).toEqual({ all: false, ids: ['con-prod'] });
    expect(access.databaseRules).toHaveLength(1);
    expect(access.databaseRules[0]).toMatchObject({ database_role: 'read_content', role_name: '报表只读' });
    expect(access.roles.map(r => r.name)).toEqual(['报表只读']);
  });

  test('resolveAccess answers "can this member open this database"', async () => {
    const role = store.saveRole({ name: '报表只读' });
    store.setRoleConnections(role.id, ['con-prod']);
    store.saveRoleDatabase({ role_id: role.id, connection_id: 'con-prod', database_names_list: 'order_db', database_role: 'read_content' });
    const saved = store.saveUser({ login: 'wangwu', roles: [role.id] });

    const granted = await permissions.resolveAccess({ userId: saved.id, conid: 'con-prod', database: 'order_db' }, null);
    expect(granted).toMatchObject({ connectionAllowed: true, databaseLevel: 'read_content', databaseAllowed: true });

    const otherDb = await permissions.resolveAccess({ userId: saved.id, conid: 'con-prod', database: 'pay_db' }, null);
    expect(otherDb).toMatchObject({ connectionAllowed: true, databaseLevel: 'deny', databaseAllowed: false });

    const otherConn = await permissions.resolveAccess({ userId: saved.id, conid: 'con-test', database: 'order_db' }, null);
    expect(otherConn.connectionAllowed).toBe(false);
  });

  test('built-in roles cannot be deleted through the API', async () => {
    await expect(permissions.deleteRole({ roleId: store.ROLE_SUPERADMIN }, null)).rejects.toThrow(/Built-in/);
  });
});
