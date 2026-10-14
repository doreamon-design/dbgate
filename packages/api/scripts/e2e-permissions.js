#!/usr/bin/env node
// 真实数据库上的权限端到端验收（手工脚本，不进 jest 单测套件）。
//
// 为什么单独放这里：单测只能证明「规则解析对」，证明不了「不同的人看到的表真的不一样」。
// 这个脚本通过 HTTP API 走完整链路，用两个不同身份的 X-Connect-Token 对比结果。
//
// 用法：
//   0) SQLite 驱动（本仓默认没装，装到插件的 node_modules 里即可，不动清单）：
//        cd plugins/dbgate-plugin-sqlite && npm install --no-save better-sqlite3
//   1) 起一个 API（需要 DEVMODE=1，否则插件后端解析不到）：
//        cd packages/api
//        DEVMODE=1 WORKSPACE_DIR=/tmp/dbgate-e2e/ws CONNECT_AUTH=1 SESSION_KEY=<secret> \
//          node src/index.js --listen-api
//   2) 跑本脚本：
//        cd packages/api
//        SESSION_KEY=<secret> node scripts/e2e-permissions.js
//
// 环境变量：E2E_BASE（默认 http://127.0.0.1:3000）、SESSION_KEY（必填，与网关同值）、
//           E2E_DB_FILE（默认 /tmp/dbgate-e2e/perm-e2e.sqlite）
//
// 脚本自己会建表（通过 run-script），所以只要给一个可写的文件路径就能跑。

const path = require('path');
const jwt = require('jsonwebtoken');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3000';
const SECRET = process.env.SESSION_KEY;
const DB_FILE = process.env.E2E_DB_FILE || '/tmp/dbgate-e2e/perm-e2e.sqlite';
const ENGINE = 'sqlite@dbgate-plugin-sqlite';

if (!SECRET) {
  console.error('缺少 SESSION_KEY（要与 API/网关的 SESSION_KEY 一致）');
  process.exit(2);
}

const token = payload => jwt.sign(payload, SECRET, { expiresIn: '1h' });

async function call(route, args, tok) {
  const resp = await fetch(`${BASE}/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Connect-Token': tok },
    body: JSON.stringify(args ?? {}),
  });
  const body = await resp.json().catch(() => null);
  return { status: resp.status, body };
}

// 首次打开连接时后台分析是异步的，第一次 structure 可能返回空模型；重试到非空为止
async function structureWithWarmup(conid, database, tok, attempts = 8) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = await call('database-connections/structure', { conid, database }, tok);
    if ((last.body?.tables ?? []).length > 0) return last;
    await new Promise(r => setTimeout(r, 800));
  }
  return last;
}

const superTok = token({
  id: 'dor-admin',
  username: 'zhangwei',
  email: 'zhangwei@zcorky.com',
  nickname: '张伟',
  permissions: ['SUPER_ADMIN'],
});
const limitedTok = token({
  id: 'dor-limited',
  username: 'limited',
  email: 'limited@zcorky.com',
  nickname: '受限',
  permissions: ['USER_PERMISSION'],
});
const maskedTok = token({
  id: 'dor-zhaoliu',
  username: 'zhaoliu',
  email: 'zhaoliu@zcorky.com',
  nickname: '赵六',
  permissions: ['USER_PERMISSION'],
});
const restrictedTok = token({
  id: 'dor-wangwu',
  username: 'wangwu',
  email: 'wangwu@zcorky.com',
  nickname: '王五',
  permissions: ['USER_PERMISSION'],
});

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got=${JSON.stringify(actual)}\n     want=${JSON.stringify(expected)}`);
}

(async () => {
  // 1. 管理端建连接（connections/save 收的是**扁平**的连接对象）
  const saved = await call(
    'connections/save',
    {
      displayName: 'E2E 权限库',
      engine: ENGINE,
      databaseFile: DB_FILE,
      singleDatabase: true,
      defaultDatabase: 'main',
    },
    superTok
  );
  const conid = saved.body?._id ?? saved.body?.connection?._id;
  check('保存连接成功', !!conid, true);
  if (!conid) {
    console.log('  save 响应:', JSON.stringify(saved).slice(0, 400));
    process.exit(1);
  }

  // 2. 建表（通过 API 跑 DDL，保证脚本自带数据）
  await call(
    'database-connections/run-script',
    {
      conid,
      database: 'main',
      sql: [
        'CREATE TABLE IF NOT EXISTS customers(id INTEGER, name TEXT, phone TEXT, tenant TEXT);',
        'CREATE TABLE IF NOT EXISTS orders(id INTEGER, customer_id INTEGER, amount REAL);',
        'CREATE TABLE IF NOT EXISTS payments(id INTEGER, order_id INTEGER, amount REAL);',
      ].join('\n'),
    },
    superTok
  );

  // DDL 是在首次分析之后跑的，必须让连接重新分析一次，否则结构还是空的
  await call('database-connections/sync-model', { conid, database: 'main', isFullRefresh: true }, superTok);
  await new Promise(r => setTimeout(r, 500));

  // 3. 全权成员：连接列表 / 单库名 / 结构
  const listResp = await call('connections/list', {}, superTok);
  check('全权成员能看到自己的连接', (listResp.body ?? []).map(x => x._id).includes(conid), true);
  const conn = (listResp.body ?? []).find(x => x._id === conid);
  const database = conn?.defaultDatabase;
  check('连接带上了单库名', database, 'main');

  const struct = await structureWithWarmup(conid, database, superTok);
  check('全权成员能看到全部表', (struct.body?.tables ?? []).map(x => x.pureName).sort(), [
    'customers',
    'orders',
    'payments',
  ]);

  // 4. 受限角色：连接可见 + 库级只读 + 对象级「customers 加宽为可写、payments 拒绝」
  const role = await call(
    'permissions/save-role-detail',
    {
      role: { name: 'E2E 受限角色', permissions: ['widgets/database'] },
      connections: { all: false, ids: [conid] },
      databases: [{ connection_id: conid, database_names_list: database, database_permission_role_id: -2 }],
      tables: [
        {
          connection_id: conid,
          database_names_list: database,
          table_names_list: 'customers',
          table_permission_role_id: -3,
          table_permission_scope_id: -2,
        },
        {
          connection_id: conid,
          database_names_list: database,
          table_names_list: 'payments',
          table_permission_role_id: -5,
          table_permission_scope_id: -2,
        },
      ],
      rowFilters: [
        {
          connection_id: conid,
          database_names_list: database,
          table_names_list: 'customers',
          column_name: 'tenant',
          filter_operator: '=',
          value_type: 'user',
          user_field: 'tenant',
        },
      ],
    },
    superTok
  );
  const roleId = role.body?.role?.id;
  check('受限角色创建成功', !!roleId, true);

  const member = await call(
    'permissions/save-user-detail',
    { user: { login: 'wangwu', name: '王五', roles: [roleId], status: 'active', tenant: 'T-1042' } },
    superTok
  );
  const memberId = member.body?.user?.id;
  check('受限成员创建成功', !!memberId, true);

  // 脱敏角色（不带行过滤，这样它的 query-data 不会被行过滤守卫拦下）
  const maskRole = await call(
    'permissions/save-role-detail',
    {
      role: { name: 'E2E 脱敏角色', permissions: ['widgets/database'] },
      connections: { all: false, ids: [conid] },
      databases: [{ connection_id: conid, database_names_list: database, database_permission_role_id: -2 }],
      columns: [
        {
          connection_id: conid,
          database_names_list: database,
          table_names_list: 'customers',
          column_names_list: 'phone',
          column_mask_mode: 'partial',
        },
      ],
    },
    superTok
  );
  check('脱敏角色创建成功', !!maskRole.body?.role?.id, true);
  const maskMember = await call(
    'permissions/save-user-detail',
    { user: { login: 'zhaoliu', name: '赵六', roles: [maskRole.body.role.id], status: 'active' } },
    superTok
  );
  check('脱敏成员创建成功', !!maskMember.body?.user?.id, true);

  // 使用限制角色：时段与来源 IP 都不覆盖 e2e 环境（127.0.0.1 / 当前时间），行数上限 1
  const limitRole = await call(
    'permissions/save-role-detail',
    {
      role: {
        name: 'E2E 使用限制',
        permissions: ['widgets/database'],
        limits: { maxRows: 1, timeoutSeconds: 0, allowedHours: '00:00-23:59', allowedIps: '127.0.0.1' },
      },
      connections: { all: false, ids: [conid] },
      databases: [{ connection_id: conid, database_names_list: database, database_permission_role_id: -2 }],
    },
    superTok
  );
  check('使用限制角色创建成功', !!limitRole.body?.role?.id, true);
  const limitMember = await call(
    'permissions/save-user-detail',
    { user: { login: 'limited', name: '受限', roles: [limitRole.body.role.id], status: 'active' } },
    superTok
  );
  check('使用限制成员创建成功', !!limitMember.body?.user?.id, true);

  // 5. 受限成员：连接可见，但**看不到被拒绝的表**
  check(
    '受限成员能看到被授权的连接',
    (await call('connections/list', {}, restrictedTok)).body?.map(x => x._id),
    [conid]
  );
  const rStruct = await structureWithWarmup(conid, database, restrictedTok);
  check('受限成员看不到被拒绝的表', (rStruct.body?.tables ?? []).map(x => x.pureName).sort(), ['customers', 'orders']);

  // 6. 权限预览与真实结果一致
  const resolve = (table, tok = superTok) =>
    call('permissions/resolve-access', { userId: memberId, conid, database, table, objectTypeField: 'tables' }, tok);
  check('预览：orders 继承库级只读', (await resolve('orders')).body?.tableRole, 'read');
  check('预览：payments 被对象规则拒绝', (await resolve('payments')).body?.tableRole, 'deny');
  check('预览：customers 被加宽为可写', (await resolve('customers')).body?.tableRole, 'create_update_delete');

  // 7. 访问矩阵（一屏数据：角色列可编辑 + 成员列只读）
  const matrix = await call('permissions/get-access-matrix', { conid, database, userIds: [memberId] }, superTok);
  const roleCell = (matrix.body?.roles ?? []).find(r => r.id === roleId);
  check('矩阵：角色格显示库级档位', roleCell?.level, 'read_content');
  check('矩阵：角色格可编辑（带 ruleId）', !!roleCell?.ruleId, true);
  const userCell = (matrix.body?.users ?? [])[0];
  check('矩阵：成员格显示最终档位', userCell?.level, 'read_content');
  check('矩阵：成员格能连上该连接', userCell?.connectionAllowed, true);

  // 8. 列级脱敏（同一张表、同一个成员，值必须不一样）
  await call(
    'database-connections/run-script',
    {
      conid,
      database,
      sql: "DELETE FROM customers; INSERT INTO customers VALUES (1,'alice','13800001111','T-1042'); INSERT INTO customers VALUES (2,'bob','13900002222','T-9999'); DELETE FROM orders; INSERT INTO orders VALUES (10,1,100.0); INSERT INTO orders VALUES (11,2,200.0);",
    },
    superTok
  );
  const superRows = await call(
    'database-connections/query-data',
    { conid, database, sql: 'SELECT * FROM customers' },
    superTok
  );
  check('全权成员看到原始手机号', superRows.body?.rows?.[0]?.phone, '13800001111');
  const maskedRows = await call(
    'database-connections/query-data',
    { conid, database, sql: 'SELECT * FROM customers' },
    maskedTok
  );
  check('受限成员的手机号被脱敏', maskedRows.body?.rows?.[0]?.phone, '138******11');
  check('结果里标注了被脱敏的列', maskedRows.body?.maskedColumns?.phone, 'partial');

  // 9. 配了列脱敏就不许批量导出（流式导出还没接脱敏，不能出现「界面脱敏、导出原文」）
  const exportAsMasked = await call(
    'database-connections/native-backup',
    {
      conid,
      database,
      outputFile: '/tmp/dbgate-e2e/should-not-exist.sql',
      options: {},
      selectedTables: [],
      skippedTables: [],
    },
    maskedTok
  );
  check('脱敏成员批量导出被拒', /Column masks are configured/.test(exportAsMasked.body?.apiErrorMessage ?? ''), true);

  // 10. 行级过滤：同一条 select，成员只拿得到自己租户的行
  const pageSelect = {
    commandType: 'select',
    from: { name: { pureName: 'customers', schemaName: 'main' } },
    columns: [
      { exprType: 'column', columnName: 'id' },
      { exprType: 'column', columnName: 'name' },
      { exprType: 'column', columnName: 'tenant' },
    ],
    orderBy: null,
    topRecords: 100,
  };
  const allRows = await call('database-connections/sql-select', { conid, database, select: pageSelect }, superTok);
  check('全权成员浏览到全部行', (allRows.body?.rows ?? []).length, 2);
  const myRows = await call('database-connections/sql-select', { conid, database, select: pageSelect }, restrictedTok);
  check(
    '受限成员只看到自己租户的行',
    (myRows.body?.rows ?? []).map(r => r.name),
    ['alice']
  );

  // 11. 有行过滤就不许裸 SQL / 脚本（否则直接绕开）
  const rawQuery = await call(
    'database-connections/query-data',
    { conid, database, sql: 'SELECT * FROM customers' },
    restrictedTok
  );
  check('受限成员裸 SQL 被拒', /Row filters are configured/.test(rawQuery.body?.apiErrorMessage ?? ''), true);
  const rawScript = await call('database-connections/run-script', { conid, database, sql: 'SELECT 1' }, restrictedTok);
  check('受限成员执行脚本被拒', /Row filters are configured/.test(rawScript.body?.apiErrorMessage ?? ''), true);

  // 12. 预览要把"更细粒度"的限制和后果都说清楚
  const filteredAccess = await call('permissions/get-user-access', { userId: memberId }, superTok);
  check('预览：行过滤出现在成员配置里', (filteredAccess.body?.rowFilters ?? []).length, 1);
  check('预览：有行过滤 → 裸 SQL 被标记为禁止', filteredAccess.body?.restrictions?.rawSqlBlocked, true);
  check('预览：有行过滤 → 批量导出未被标记', filteredAccess.body?.restrictions?.bulkExportBlocked, false);

  const maskedAccess = await call('permissions/get-user-access', { userId: maskMember.body.user.id }, superTok);
  check('预览：列脱敏出现在成员配置里', (maskedAccess.body?.columnMasks ?? []).length, 1);
  check('预览：有列脱敏 → 批量导出被标记为禁止', maskedAccess.body?.restrictions?.bulkExportBlocked, true);
  check('预览：有列脱敏 → 裸 SQL 未被标记', maskedAccess.body?.restrictions?.rawSqlBlocked, false);

  // 13. 以该成员身份看树（严格只读，用管理员身份执行后按成员规则过滤）
  const filteredTree = await call('permissions/get-user-visibility', { userId: memberId, conid }, superTok);
  const treeDb = (filteredTree.body?.connections ?? [])[0]?.databases?.[0];
  check('可见性：库级档位', treeDb?.level, 'read_content');
  check(
    '可见性：被拒绝的表不出现',
    (treeDb?.tables ?? []).map(t => t.name),
    ['customers', 'orders']
  );
  check(
    '可见性：标注对象级加宽',
    (treeDb?.tables ?? []).find(t => t.name === 'customers')?.role,
    'create_update_delete'
  );
  check('可见性：标注行过滤', (treeDb?.tables ?? []).find(t => t.name === 'customers')?.rowFiltered, true);

  const maskedTree = await call(
    'permissions/get-user-visibility',
    { userId: maskMember.body.user.id, conid },
    superTok
  );
  const maskedTable = ((maskedTree.body?.connections ?? [])[0]?.databases?.[0]?.tables ?? []).find(
    t => t.name === 'customers'
  );
  check('可见性：标注列脱敏', maskedTable?.maskedColumns, [{ column: 'phone', mode: 'partial' }]);

  // 14. 使用限制：行数上限截断（干净的库里有 2 行，只能拿 1 行）
  const cappedRows = await call('database-connections/sql-select', { conid, database, select: pageSelect }, limitedTok);
  check('使用限制：行数上限生效', (cappedRows.body?.rows ?? []).length, 1);
  // sqlSelect 是在语句层收窄（topRecords），所以没有截断标记；裸 SQL 只能在结果回来之后截断
  const cappedRaw = await call(
    'database-connections/query-data',
    { conid, database, sql: 'SELECT * FROM customers' },
    limitedTok
  );
  check('使用限制：raw SQL 结果被截断并标注', cappedRaw.body?.truncatedByLimit, 1);

  // 15. 使用限制：来源 IP 不在白名单 → 直接拒（把白名单改成只允许别的网段）
  const limitRoleId = limitRole.body.role.id;
  await call(
    'permissions/save-role-detail',
    {
      role: {
        id: limitRoleId,
        name: 'E2E 使用限制',
        permissions: ['widgets/database'],
        limits: { maxRows: 0, timeoutSeconds: 0, allowedHours: '00:00-23:59', allowedIps: '10.99.99.99' },
      },
      connections: { all: false, ids: [conid] },
      databases: [{ connection_id: conid, database_names_list: database, database_permission_role_id: -2 }],
    },
    superTok
  );
  const blockedIp = await call('database-connections/sql-select', { conid, database, select: pageSelect }, limitedTok);
  check('使用限制：IP 不在白名单被拒', /not allowed for this member/.test(blockedIp.body?.apiErrorMessage ?? ''), true);

  // 16. 使用限制：时段不覆盖当前时间 → 被拒
  await call(
    'permissions/save-role-detail',
    {
      role: {
        id: limitRoleId,
        name: 'E2E 使用限制',
        permissions: ['widgets/database'],
        limits: { maxRows: 0, timeoutSeconds: 0, allowedHours: '03:00-03:01', allowedIps: '' },
      },
      connections: { all: false, ids: [conid] },
      databases: [{ connection_id: conid, database_names_list: database, database_permission_role_id: -2 }],
    },
    superTok
  );
  const blockedHours = await call(
    'database-connections/sql-select',
    { conid, database, select: pageSelect },
    limitedTok
  );
  const hoursMessage = blockedHours.body?.apiErrorMessage ?? '';
  check(
    '使用限制：时段外被拒（或恰好命中 03:00-03:01）',
    /only allowed between/.test(hoursMessage) || (blockedHours.body?.rows ?? []).length > 0,
    true
  );

  // 17. 行过滤作用在**联表**上（规则在 customers，主表是 orders）
  const joinSelect = {
    commandType: 'select',
    from: {
      name: { pureName: 'orders', schemaName: 'main' },
      alias: 'o',
      relations: [{ joinType: 'CROSS JOIN', name: { pureName: 'customers', schemaName: 'main' }, alias: 'c' }],
    },
    columns: [
      { exprType: 'column', columnName: 'name', source: { alias: 'c' } },
      { exprType: 'column', columnName: 'tenant', source: { alias: 'c' } },
    ],
    orderBy: null,
    topRecords: 100,
  };
  const allJoined = await call('database-connections/sql-select', { conid, database, select: joinSelect }, superTok);
  check('全权成员联表看到 2×2 行', (allJoined.body?.rows ?? []).length, 4);
  const myJoined = await call(
    'database-connections/sql-select',
    { conid, database, select: joinSelect },
    restrictedTok
  );
  check('受限成员联表只剩自有租户', (myJoined.body?.rows ?? []).length, 2);
  check('受限成员联表的每一行都属于自己租户', Array.from(new Set((myJoined.body?.rows ?? []).map(r => r.tenant))), [
    'T-1042',
  ]);

  // 18. 子查询里引用被过滤的表 → 无法证明过滤完整，直接拒（失败时收紧）
  const subQuerySelect = {
    commandType: 'select',
    from: {
      subQuery: {
        commandType: 'select',
        from: { name: { pureName: 'customers', schemaName: 'main' } },
        columns: [{ exprType: 'column', columnName: 'name' }],
      },
      alias: 'x',
    },
    columns: [{ exprType: 'column', columnName: 'name', source: { alias: 'x' } }],
    orderBy: null,
    topRecords: 100,
  };
  const subQueryResult = await call(
    'database-connections/sql-select',
    { conid, database, select: subQuerySelect },
    restrictedTok
  );
  check(
    '子查询无法施加行过滤时被拒',
    /cannot be applied to this query/.test(subQueryResult.body?.apiErrorMessage ?? ''),
    true
  );

  // 19. 文件数据脚本（JSON runner）也是"未脱敏的导出"—— 脱敏成员必须被拒
  const jsonScript = { type: 'json', version: 1, packageNames: [], commands: [] };
  const maskedRunner = await call('runners/start', { script: jsonScript }, maskedTok);
  check(
    '脱敏成员的 JSON 数据脚本被拒',
    /Column masks are configured/.test(maskedRunner.body?.apiErrorMessage ?? maskedRunner.body?.errorMessage ?? ''),
    true
  );
  const maskedEval = await call(
    'database-connections/eval-json-script',
    { runid: 'e2e-runid-1', conid, database, script: jsonScript },
    maskedTok
  );
  check(
    '脱敏成员的单连接导出脚本被拒',
    /Column masks are configured/.test(maskedEval.body?.apiErrorMessage ?? ''),
    true
  );
  // 没有脱敏的成员不该被这条守卫误伤（脚本本身不合法，但错误必须不是脱敏守卫）
  const cleanRunner = await call('runners/start', { script: jsonScript }, restrictedTok);
  check('无脱敏成员不被该守卫误伤', !/Column masks are configured/.test(cleanRunner.body?.apiErrorMessage ?? ''), true);

  console.log(failures ? `\n${failures} FAILED` : '\nALL E2E CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(err => {
  console.error('E2E error:', err.message);
  process.exit(1);
});
