// 权限引擎与本地存储的接线测试。
//
// 这是本次改造最关键的一段：hasPermission.js 里的两处 STORAGE_DATABASE 短路改成
// isPermissionStoreActive() 之后，「谁能连哪个连接 / 看哪个库 / 需要什么档位」必须
// 真的生效，同时**存储不存在时行为必须与改造前完全一致**。

const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('./permissionStore');
const {
  testConnectionPermission,
  testDatabaseRolePermission,
  loadPermissionsFromRequest,
} = require('./hasPermission');

let workdir;

function connectReq(login, userId) {
  return { user: { amoid: 'connect', login, userId } };
}

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbgate-hasperm-'));
  process.env.WORKSPACE_DIR = workdir;
});

afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  delete process.env.CONNECT_AUTH;
  delete process.env.SESSION_KEY;
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe('without any permission store (pre-upgrade behaviour)', () => {
  test('database role checks are skipped entirely', async () => {
    expect(store.isPermissionStoreActive()).toBe(false);
    // 改造前：没有 storage 数据库时 testDatabaseRolePermission 直接返回，不做任何判定
    await expect(testDatabaseRolePermission('con-1', 'anything', 'run_script', null)).resolves.toBeUndefined();
  });

  test('connection permission falls back to the plain permission string', async () => {
    // 未启用存储时用默认 provider，且权限为空 → 放行（与改造前一致）
    await expect(testConnectionPermission('con-1', null)).resolves.toBeUndefined();
  });
});

describe('with the permission store active', () => {
  async function makeRestrictedMember() {
    store.ensureBootstrap();
    const role = store.saveRole({ name: '报表只读', permissions: ['widgets/database'] });
    store.setRoleConnections(role.id, ['con-prod']);
    store.saveRoleDatabase({
      role_id: role.id,
      connection_id: 'con-prod',
      database_names_list: 'order_db',
      database_role: 'read_content',
    });
    store.saveUser({ login: 'wangwu', name: '王五', roles: [role.id] });
    const user = store.findUserForLogin('wangwu');
    return connectReq('wangwu', user.id);
  }

  test('the legacy/compat role keeps full access', async () => {
    store.ensureBootstrap();
    const forced = store.findUserForLogin('admin');
    const req = connectReq('admin', forced.id);
    await expect(testConnectionPermission('con-anything', req)).resolves.toBeUndefined();
    await expect(testDatabaseRolePermission('con-anything', 'any_db', 'run_script', req)).resolves.toBeUndefined();
  });

  test('a restricted member cannot reach an ungranted connection', async () => {
    const req = await makeRestrictedMember();
    await expect(testConnectionPermission('con-prod', req)).resolves.toBeUndefined();
    await expect(testConnectionPermission('con-test', req)).rejects.toThrow(/DBGM-0026[34]/);
  });

  test('database levels are enforced inside a granted connection', async () => {
    const req = await makeRestrictedMember();
    // order_db 给了 read_content：只读要求通过，写数据要求被拒
    await expect(testDatabaseRolePermission('con-prod', 'order_db', 'read_content', req)).resolves.toBeUndefined();
    await expect(testDatabaseRolePermission('con-prod', 'order_db', 'write_data', req)).rejects.toThrow(/DBGM-00266/);
    await expect(testDatabaseRolePermission('con-prod', 'order_db', 'run_script', req)).rejects.toThrow(/DBGM-00266/);
    // 没配规则的库 = 无权限（默认拒绝）
    await expect(testDatabaseRolePermission('con-prod', 'pay_db', 'view', req)).rejects.toThrow(/DBGM-00266/);
  });

  test('a disabled member is denied everywhere', async () => {
    const req = await makeRestrictedMember();
    const user = store.findUserForLogin('wangwu');
    store.saveUser({ ...user, status: 'disabled' });
    await expect(testConnectionPermission('con-prod', req)).rejects.toThrow(/DBGM-0026[34]/);
    await expect(testDatabaseRolePermission('con-prod', 'order_db', 'view', req)).rejects.toThrow(/DBGM-00266/);
  });

  test('an unknown member fails closed, not open', async () => {
    store.ensureBootstrap();
    const req = connectReq('ghost', 'u-ghost');
    const permissions = await loadPermissionsFromRequest(req);
    // 关键：绝不能返回 null/[]，否则 hasPermission() 会退化成「全放行」
    expect(permissions).toEqual(store.DENY_ALL_PERMISSIONS);
    await expect(testConnectionPermission('con-prod', req)).rejects.toThrow(/DBGM-0026[34]/);
    await expect(testDatabaseRolePermission('con-prod', 'order_db', 'view', req)).rejects.toThrow(/DBGM-00266/);
  });
});
