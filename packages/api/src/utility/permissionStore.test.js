const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('./permissionStore');
const { compilePermissions, testPermission } = require('dbgate-tools');

let workdir;

function freshDir() {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbgate-perm-'));
  process.env.WORKSPACE_DIR = workdir;
  return workdir;
}

beforeEach(() => {
  freshDir();
});

afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  delete process.env.LOGIN;
  delete process.env.PERMISSIONS;
  delete process.env.CONNECT_AUTH;
  delete process.env.SESSION_KEY;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('LOGIN_PASSWORD_') || key.startsWith('LOGIN_PERMISSIONS_')) delete process.env[key];
  }
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe('permission store activation', () => {
  test('is inactive until the store file exists', () => {
    expect(store.isPermissionStoreActive()).toBe(false);
    store.ensureBootstrap();
    expect(store.isPermissionStoreActive()).toBe(true);
  });

  test('is active when CONNECT_AUTH is enabled even before the file exists', () => {
    process.env.CONNECT_AUTH = '1';
    expect(store.isPermissionStoreActive()).toBe(true);
    expect(store.isConnectAuthEnabled()).toBe(true);
  });

  test('does not treat a bare SECRET_KEY as an opt-in', () => {
    process.env.SECRET_KEY = 'whatever';
    expect(store.isConnectAuthEnabled()).toBe(false);
  });
});

describe('bootstrap', () => {
  test('creates built-in roles and a local admin, and is idempotent', () => {
    const first = store.ensureBootstrap();
    expect(first.created).toBe(true);
    expect(store.listRoles().map(r => r.id).sort()).toEqual(['legacy-all', 'superadmin', 'unassigned'].sort());

    const admin = store.listUsers()[0];
    expect(admin.login).toBe('admin');
    expect(admin.roles).toEqual([store.ROLE_LEGACY]);
    expect(admin.superAdminSource).toBe('local');

    const second = store.ensureBootstrap();
    expect(second.created).toBe(false);
    expect(store.listUsers()).toHaveLength(1);
  });

  test('migrates existing env logins so their access is not taken away', () => {
    process.env.LOGIN = 'boss';
    process.env.LOGIN_PASSWORD_alice = 'x';
    process.env.LOGIN_PASSWORD_bob = 'y';

    store.ensureBootstrap();
    const logins = store.listUsers().map(u => u.login).sort();
    expect(logins).toEqual(['alice', 'bob', 'boss']);

    for (const login of logins) {
      const user = store.findUserForLogin(login);
      const permissions = store.buildUserPermissions(user);
      // 升级前后行为一致：老登录仍然能看全部连接、全部数据库
      expect(testPermission('all-connections', compilePermissions(permissions))).toBe(true);
      expect(testPermission('all-databases', compilePermissions(permissions))).toBe(true);
    }
  });
});

describe('permission strings', () => {
  beforeEach(() => {
    store.ensureBootstrap();
  });

  test('legacy role keeps the pre-upgrade behaviour', () => {
    const user = store.findUserForLogin('admin');
    const permissions = store.buildUserPermissions(user);
    const compiled = compilePermissions(permissions);
    expect(testPermission('all-connections', compiled)).toBe(true);
    expect(testPermission('all-databases', compiled)).toBe(true);
    expect(testPermission('admin/users', compiled)).toBe(false);
  });

  test('team base denies admin/* and broad database access', () => {
    const permissions = store.buildUserPermissions(store.findUserForLogin('admin'));
    const compiled = compilePermissions(store.DENY_ALL_PERMISSIONS);
    expect(permissions).toContain('~all-databases');
    // ~* 必须真的拒绝一切：空数组在 compilePermissions 里会退化成「全放行」
    expect(testPermission('all-databases', compiled)).toBe(false);
    expect(testPermission('admin/users', compiled)).toBe(false);
    expect(testPermission('connections/con-1', compiled)).toBe(false);
  });

  test('a restricted role only sees its granted connections and databases', () => {
    const role = store.saveRole({ name: '只读报表', permissions: ['widgets/database'] });
    store.setRoleConnections(role.id, ['con-prod']);
    store.saveRoleDatabase({ role_id: role.id, connection_id: 'con-prod', database_names_list: 'order_db', database_role: 'read_content' });

    store.saveUser({ login: 'wangwu', name: '王五', roles: [role.id] });
    const user = store.findUserForLogin('wangwu');
    const permissions = store.buildUserPermissions(user);
    const compiled = compilePermissions(permissions);

    expect(testPermission('connections/con-prod', compiled)).toBe(true);
    expect(testPermission('connections/con-test', compiled)).toBe(false);
    expect(testPermission('all-databases', compiled)).toBe(false);

    const dbPermissions = store.getUserDatabasePermissions(user);
    expect(dbPermissions).toHaveLength(1);
    expect(dbPermissions[0]).toMatchObject({
      role_id: role.id,
      connection_id: 'con-prod',
      database_names_list: 'order_db',
      database_permission_role_id: -2, // read_content
    });
  });

  test('disabled members fall back to deny-all permissions', () => {
    const user = store.findUserForLogin('admin');
    store.saveUser({ ...user, status: 'disabled' });
    const disabled = store.findUserForLogin('admin');
    expect(store.buildUserPermissions(disabled)).toEqual(store.DENY_ALL_PERMISSIONS);
    expect(store.getUserDatabasePermissions(disabled)).toEqual([]);
  });

  test('environment PERMISSIONS still applies on top of the base', () => {
    process.env.PERMISSIONS = 'admin/users';
    const user = store.findUserForLogin('admin');
    const compiled = compilePermissions(store.buildUserPermissions(user));
    expect(testPermission('admin/users', compiled)).toBe(true);
    expect(testPermission('admin/roles', compiled)).toBe(false);
  });
});

describe('role and grant administration', () => {
  beforeEach(() => {
    store.ensureBootstrap();
  });

  test('built-in roles cannot be deleted and cannot have permissions edited', () => {
    expect(() => store.deleteRole(store.ROLE_SUPERADMIN)).toThrow(/Built-in/);
    const edited = store.saveRole({ id: store.ROLE_SUPERADMIN, name: 'hacked', permissions: ['~*'] });
    expect(edited.permissions).toEqual(['all-connections', 'all-databases', 'all-tables', 'admin/*', 'internal-storage']);
  });

  test('the superadmin role really grants the administration surface', () => {
    const admin = store.findUserForLogin('admin');
    store.saveUser({ ...admin, roles: [store.ROLE_SUPERADMIN] });
    const compiled = compilePermissions(store.buildUserPermissions(store.findUserForLogin('admin')));
    expect(testPermission('all-databases', compiled)).toBe(true);
    expect(testPermission('all-connections', compiled)).toBe(true);
    expect(testPermission('all-tables', compiled)).toBe(true);
    expect(testPermission('admin/users', compiled)).toBe(true);
    expect(testPermission('admin/roles', compiled)).toBe(true);
    expect(testPermission('admin/auditlog', compiled)).toBe(true);
    expect(testPermission('internal-storage', compiled)).toBe(true);
  });

  test('a role in use cannot be deleted', () => {
    const role = store.saveRole({ name: '临时角色' });
    store.saveUser({ login: 'temp', roles: [role.id] });
    expect(() => store.deleteRole(role.id)).toThrow(/assigned/);
  });

  test('the last superadmin cannot be deleted', () => {
    const admin = store.findUserForLogin('admin');
    store.saveUser({ ...admin, roles: [store.ROLE_SUPERADMIN] });
    expect(() => store.deleteUser(admin.id)).toThrow(/last superadmin/);
  });

  test('database levels are stored with storageModel numeric ids', () => {
    const role = store.saveRole({ name: '等级校验' });
    const row = store.saveRoleDatabase({ role_id: role.id, connection_id: 'c', database_names_list: 'db', database_role: 'write_data' });
    expect(row.database_permission_role_id).toBe(-3);
    expect(() => store.saveRoleDatabase({ role_id: role.id, database_role: 'not-a-level' })).toThrow(/Unknown database permission role/);
  });

  test('table scopes are stored with storageModel numeric ids', () => {
    const role = store.saveRole({ name: '对象校验' });
    const row = store.saveRoleTable({
      role_id: role.id,
      connection_id: 'c',
      database_names_list: 'db',
      table_names_list: 'orders',
      table_role: 'create_update_delete',
      table_scope: 'tables',
    });
    expect(row.table_permission_role_id).toBe(-3);
    expect(row.table_permission_scope_id).toBe(-2);
    expect(() => store.saveRoleTable({ role_id: role.id, table_role: 'read', table_scope: 'nope' })).toThrow(
      /Unknown table permission scope/
    );
  });

  test('deleting a role removes its grants', () => {
    const role = store.saveRole({ name: '待删除' });
    store.setRoleConnections(role.id, ['c1']);
    store.saveRoleDatabase({ role_id: role.id, connection_id: 'c1', database_role: 'view' });
    store.deleteRole(role.id);
    expect(store.listRoleConnections(role.id)).toHaveLength(0);
    expect(store.listRoleDatabases(role.id)).toHaveLength(0);
  });
});
