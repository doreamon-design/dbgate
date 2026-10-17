// 管理界面的后端接口端到端测试：把前端每个页面用的接口按真实入参跑一遍。
// 用法：API_URL=http://127.0.0.1:3000 X_CONNECT_TOKEN=xxx node scripts/test-admin-api.js
const API = process.env.API_URL || 'http://127.0.0.1:3000';
const TOKEN = process.env.X_CONNECT_TOKEN;
let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, extra ?? ''); } };
async function api(path, body) {
  const r = await fetch(`${API}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Connect-Token': TOKEN }, body: JSON.stringify(body ?? {}) });
  const txt = await r.text();
  try { return JSON.parse(txt); } catch (e) { return { apiErrorMessage: `non-JSON ${r.status}: ${txt.slice(0, 80)}` }; }
}
(async () => {
  console.log('== 1. 概览 / 成员列表（页面：概览、用户、矩阵、预览、来源 都依赖）==');
  const summary = await api('permissions/get-summary');
  ok(summary?.path && summary?.connectAuth, 'get-summary 返回 path + connectAuth');
  const ul = await api('permissions/get-user-list');
  ok(Array.isArray(ul?.users) && Array.isArray(ul?.roles), 'get-user-list 返回 users[] + roles[]');

  console.log('== 2. 角色：新建（页面：角色与授权）==');
  const created = await api('permissions/save-role-detail', { role: { name: `E2E角色-${Date.now()}`, description: 'api e2e' } });
  const roleId = created?.role?.id ?? created?.id;
  ok(!!roleId, 'save-role-detail 建角色成功', JSON.stringify(created).slice(0, 120));
  if (!roleId) process.exit(1);

  console.log('== 3. 库规则三模式（页面：角色与授权 → 数据库）==');
  const r1 = await api('permissions/save-role-database', { role_id: roleId, connection_id: '*', database_names_list: 'mp_cd, mp_sh', database_names_regex: '', database_permission_role_id: -2 });
  ok(!!r1?.row?.id, 'save-role-database · 名单模式', JSON.stringify(r1).slice(0, 100));
  const r2 = await api('permissions/save-role-database', { role_id: roleId, connection_id: '*', database_names_list: '', database_names_regex: '^mp_(cd|sh)$', database_permission_role_id: -1 });
  ok(!!r2?.row?.id, 'save-role-database · 正则模式(view 档位)', JSON.stringify(r2).slice(0, 100));
  const r3 = await api('permissions/save-role-database', { role_id: roleId, connection_id: '*', database_names_list: '', database_names_regex: '.*', database_permission_role_id: -3 });
  ok(!!r3?.row?.id, 'save-role-database · 全部库(regex .*)', JSON.stringify(r3).slice(0, 100));
  const detail1 = await api('permissions/get-role-detail', { roleId });
  ok((detail1?.databases ?? []).length === 3, 'get-role-detail 读回 3 条库规则', `实际 ${(detail1?.databases ?? []).length}`);

  console.log('== 4. 对象级 + 细粒度（页面：角色与授权 → 对象 / 细粒度）==');
  const t1 = await api('permissions/save-role-table', { role_id: roleId, connection_id: '*', database_names_list: 'mp_cd', table_names_list: 't_demo', table_role: 'read', table_scope: 'tables' });
  ok(!!t1?.row?.id, 'save-role-table 对象级(read)', JSON.stringify(t1).slice(0, 110));
  const c1 = await api('permissions/save-role-column', { role_id: roleId, connection_id: '*', database_names_list: 'mp_cd', table_names_list: 't_demo', column_names_list: 'phone', column_mask_mode: 'partial' });
  ok(!!c1?.row?.id, 'save-role-column 列脱敏(partial)', JSON.stringify(c1).slice(0, 110));
  const f1 = await api('permissions/save-role-row-filter', { role_id: roleId, connection_id: '*', database_names_list: 'mp_cd', table_names_list: 't_demo', column_name: 'tenant_id', user_field: process.env.ROW_USER_FIELD || 'login', value_type: 'user' });
  ok(!!f1?.row?.id, 'save-role-row-filter 行过滤', JSON.stringify(f1).slice(0, 110));
  const detail2 = await api('permissions/get-role-detail', { roleId });
  ok((detail2?.tables ?? []).length >= 1, '细节读回对象规则');
  ok((detail2?.columns ?? []).length >= 1, '细节读回列脱敏');
  ok((detail2?.rowFilters ?? []).length >= 1, '细节读回行过滤');

  console.log('== 5. 成员：新建并挂角色（页面：用户）==');
  const login = `e2e-${Date.now()}@test`;
  const u1 = await api('permissions/save-user-detail', { user: { login, name: 'E2E 成员', roles: [roleId], status: 'active' } });
  const userId = u1?.user?.id;
  ok(!!userId, 'save-user-detail 建成员', JSON.stringify(u1).slice(0, 120));
  const ul2 = await api('permissions/get-user-list');
  ok((ul2?.users ?? []).some(x => x.login === login), 'get-user-list 里能查到新成员');

  console.log('== 6. 生效校验（页面：预览 / 矩阵）==');
  const acc = await api('permissions/get-user-access', { userId });
  ok((acc?.roles ?? []).some(r => r.id === roleId), 'get-user-access 里能看到新角色', JSON.stringify(acc).slice(0, 120));
  ok(acc?.restrictions?.rawSqlBlocked === true, '配了行过滤 → 裸 SQL 被禁（restrictions.rawSqlBlocked）');
  const vis = await api('permissions/get-user-visibility', { userId });
  ok(!!vis && !vis.apiErrorMessage, 'get-user-visibility 正常返回');
  const mx = await api('permissions/get-access-matrix', { conid: '*', database: 'mp_cd' });
  ok(!!mx && !mx.apiErrorMessage, 'get-access-matrix 正常返回');

  console.log('== 7. 审计（页面：审计日志）==');
  const log = await api('permissions/get-change-log', { limit: 20 });
  ok(Array.isArray(log?.entries), 'get-change-log 返回 entries[]');

  console.log('== 8. 清理 ==');
  const d1 = await api('permissions/delete-user', { userId });
  ok(d1?.success !== false, 'delete-user');
  const d2 = await api('permissions/delete-role', { roleId });
  ok(d2?.success !== false, 'delete-role');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
