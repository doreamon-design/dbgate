const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const store = require('../utility/permissionStore');
const connect = require('./connectAuthProvider');
const { AuthProviderBase } = require('./authProvider');
const { compilePermissions, testPermission } = require('dbgate-tools');

const SECRET = 'test-session-key';
let workdir;

function sign(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: '1h' });
}

function reqWith(token) {
  return { headers: token ? { 'x-connect-token': token } : {}, query: {} };
}

function connectPayload(overrides = {}) {
  return {
    id: 'dor-1',
    username: 'lisi',
    email: 'lisi@zcorky.com',
    nickname: '李四',
    permissions: [],
    ...overrides,
  };
}

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbgate-connect-'));
  process.env.WORKSPACE_DIR = workdir;
  process.env.CONNECT_AUTH = '1';
  process.env.SESSION_KEY = SECRET;
  store.ensureBootstrap();
});

afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  delete process.env.CONNECT_AUTH;
  delete process.env.SESSION_KEY;
  delete process.env.SECRET_KEY;
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe('token decoding', () => {
  test('does nothing when connect auth is off', () => {
    delete process.env.CONNECT_AUTH;
    expect(connect.decodeConnectToken(reqWith(sign(connectPayload())))).toBeNull();
  });

  test('returns null when the gateway did not send a token', () => {
    expect(connect.decodeConnectToken(reqWith(null))).toBeNull();
  });

  test('refuses to guess when the shared secret is missing', () => {
    delete process.env.SESSION_KEY;
    const res = connect.decodeConnectToken(reqWith(sign(connectPayload())));
    expect(res.error).toMatch(/SESSION_KEY/);
  });

  test('accepts a valid token and maps the claims', () => {
    const res = connect.decodeConnectToken(reqWith(sign(connectPayload({ permissions: ['SUPER_ADMIN', 'X'] }))));
    expect(res.error).toBeUndefined();
    expect(res.connectUser).toEqual({
      id: 'dor-1',
      email: 'lisi@zcorky.com',
      nickname: '李四',
      avatar: '',
      feishuOpenId: '',
      login: 'lisi',
      permissions: ['SUPER_ADMIN', 'X'],
    });
  });

  test('falls back to email then id for the login, and treats a malformed permissions claim as empty', () => {
    const noUsername = connect.decodeConnectToken(reqWith(sign(connectPayload({ username: undefined, permissions: 'SUPER_ADMIN' }))));
    expect(noUsername.connectUser.login).toBe('lisi@zcorky.com');
    expect(noUsername.connectUser.permissions).toEqual([]);

    const noEmail = connect.decodeConnectToken(
      reqWith(sign(connectPayload({ username: undefined, email: undefined, permissions: undefined })))
    );
    expect(noEmail.connectUser.login).toBe('dor-1');
    expect(noEmail.connectUser.permissions).toEqual([]);
  });

  test('rejects a token signed with another secret', () => {
    const forged = jwt.sign(connectPayload({ permissions: ['SUPER_ADMIN'] }), 'not-the-secret');
    expect(connect.decodeConnectToken(reqWith(forged)).error).toMatch(/invalid/i);
  });

  test('also reads the token from the query string', () => {
    const token = sign(connectPayload());
    expect(connect.decodeConnectToken({ headers: {}, query: { 'X-Connect-Token': token } }).connectUser.login).toBe('lisi');
    expect(connect.decodeConnectToken({ headers: {}, query: { access_token: token } }).connectUser.login).toBe('lisi');
  });
});

describe('SUPER_ADMIN auto elevation (PLAN 2.4.1)', () => {
  const login = permissions => connect.materializeMember(connect.connectUserFromPayload(connectPayload({ permissions })));

  test('first login with SUPER_ADMIN becomes superadmin and is audited as elevate', () => {
    const res = login(['SUPER_ADMIN']);
    expect(res.isNew).toBe(true);
    expect(res.action).toBe('elevate');
    expect(res.user.roles).toContain(store.ROLE_SUPERADMIN);
    expect(res.user.superAdminSource).toBe('doreamon');
  });

  test('a second login carrying SUPER_ADMIN is idempotent (no state change)', () => {
    login(['SUPER_ADMIN']);
    const again = login(['SUPER_ADMIN']);
    expect(again.action).toBe('elevate');
    expect(again.changed).toBe(false);
    expect(again.user.roles.filter(r => r === store.ROLE_SUPERADMIN)).toHaveLength(1);
  });

  test('losing SUPER_ADMIN revokes only the doreamon grant', () => {
    login(['SUPER_ADMIN']);
    const revoked = login(['USER_PERMISSION']);
    expect(revoked.action).toBe('revoke');
    expect(revoked.user.roles).not.toContain(store.ROLE_SUPERADMIN);
    expect(revoked.user.roles).toEqual([store.ROLE_UNASSIGNED]);
    expect(revoked.user.superAdminSource).toBeNull();
  });

  test('an empty permissions claim is not a revocation', () => {
    login(['SUPER_ADMIN']);
    const empty = login([]);
    expect(empty.action).toBe('skip');
    expect(empty.changed).toBe(false);
    expect(empty.user.roles).toContain(store.ROLE_SUPERADMIN);
    expect(empty.user.superAdminSource).toBe('doreamon');
  });

  test('a locally granted fallback admin is never auto-demoted', () => {
    const admin = store.findUserForLogin('admin');
    expect(admin.superAdminSource).toBe('local');
    const res = connect.materializeMember(
      connect.connectUserFromPayload(connectPayload({ username: 'admin', email: '', id: 'dor-admin', permissions: ['USER_PERMISSION'] }))
    );
    expect(res.action).toBe('skip');
    expect(res.user.superAdminSource).toBe('local');
  });

  test('an ordinary member without SUPER_ADMIN lands on the unassigned role', () => {
    const res = login(['USER_PERMISSION']);
    expect(res.isNew).toBe(true);
    expect(res.user.roles).toEqual([store.ROLE_UNASSIGNED]);
  });
});

describe('connect auth provider', () => {
  const Provider = connect.createConnectAuthProvider(AuthProviderBase);

  test('is registered as a redirect-style provider', () => {
    const provider = new Provider();
    expect(provider.amoid).toBe('connect');
    expect(provider.toJson()).toMatchObject({ amoid: 'connect', workflowType: 'redirect' });
  });

  test('denies everything for an unknown member instead of failing open', async () => {
    const provider = new Provider();
    const permissions = await provider.getCurrentPermissions({ user: { userId: 'nobody', login: 'nobody' } });
    expect(permissions).toEqual(store.DENY_ALL_PERMISSIONS);
    const compiled = compilePermissions(permissions);
    expect(testPermission('all-databases', compiled)).toBe(false);
    expect(testPermission('admin/users', compiled)).toBe(false);
    expect(testPermission('connections/anything', compiled)).toBe(false);
  });

  test('resolves the member from the request and honours the role grants', async () => {
    const role = store.saveRole({ name: '报表只读', permissions: ['widgets/database'] });
    store.setRoleConnections(role.id, ['con-prod']);
    store.saveRoleDatabase({ role_id: role.id, connection_id: 'con-prod', database_role: 'read_content' });
    const { user } = connect.materializeMember(
      connect.connectUserFromPayload(connectPayload({ username: 'wangwu', permissions: ['USER_PERMISSION'] }))
    );
    store.saveUser({ ...user, roles: [role.id] });

    const provider = new Provider();
    const req = { user: { userId: user.id, login: 'wangwu' } };
    const compiled = compilePermissions(await provider.getCurrentPermissions(req));

    expect(testPermission('widgets/database', compiled)).toBe(true);
    expect(testPermission('all-databases', compiled)).toBe(false);
    expect(testPermission('connections/con-prod', compiled)).toBe(true);
    expect(testPermission('connections/con-test', compiled)).toBe(false);

    await expect(provider.checkCurrentConnectionPermission(req, 'con-prod')).resolves.toBe(true);
    await expect(provider.checkCurrentConnectionPermission(req, 'con-test')).resolves.toBe(false);
    expect(await provider.getCurrentDatabasePermissions(req)).toHaveLength(1);
  });

  test('a disabled member gets deny-all and no connection access', async () => {
    const { user } = connect.materializeMember(connect.connectUserFromPayload(connectPayload({ permissions: ['SUPER_ADMIN'] })));
    store.saveUser({ ...user, status: 'disabled' });
    const provider = new Provider();
    const req = { user: { userId: user.id, login: user.login } };
    expect(await provider.getCurrentPermissions(req)).toEqual(store.DENY_ALL_PERMISSIONS);
    await expect(provider.checkCurrentConnectionPermission(req, 'con-prod')).resolves.toBe(false);
  });
});
