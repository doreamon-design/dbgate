<script lang="ts">
  import { onMount } from 'svelte';
  import { apiCall } from '../utility/api';
  import { _t } from '../translations';

  // ============================================================
  // 照 prototype/dbgate-permissions/index.html 1:1 实现的「角色与授权」
  // - 结构与样式直接搬原型（原型自带设计变量，不再依赖 dbgate 主题 token）
  // - 数据接真实接口：角色列表/详情、连接、库清单、保存/删除库规则
  // - 本页先落「数据库」子页（含 all/list/regex 三模式 + 命中库预演）
  // ============================================================

  export const matchingProps = [];

  const SECTIONS = [
    { id: 'overview', name: '概览' },
    { id: 'users', name: '用户' },
    { id: 'roles', name: '角色与授权' },
    { id: 'matrix', name: '访问矩阵' },
    { id: 'preview', name: '权限预览 / 模拟' },
    { id: 'audit', name: '审计日志' },
    { id: 'auth', name: '登录 / 成员来源' },
  ];
  const ROLE_TABS = [
    ['basic', '基础'],
    ['connections', '连接'],
    ['databases', '数据库'],
    ['objects', '对象'],
    ['operations', '操作权限'],
    ['advanced', '细粒度 / 限制'],
    ['members', '成员'],
  ];
  const SECTION_ICON = {
    overview: 'icon admin',
    users: 'icon user',
    roles: 'icon lock',
    matrix: 'icon table',
    preview: 'icon search',
    audit: 'icon history',
    auth: 'icon link',
  };
  // 档位与引擎一致（permissionLevels.js: view=-1, read_content=-2, write_data=-3, run_script=-4, deny=-5）
  const LEVELS = [
    { id: 'deny', name: '无权限', cls: 'lv-deny', num: -5 },
    { id: 'view', name: '可见（不可读内容）', cls: 'lv-view', num: -1 },
    { id: 'read_content', name: '只读内容', cls: 'lv-read', num: -2 },
    { id: 'write_data', name: '可写数据', cls: 'lv-write', num: -3 },
    { id: 'run_script', name: '可执行脚本', cls: 'lv-script', num: -4 },
  ];
  const LEVEL_BY_NUM = Object.fromEntries(LEVELS.map(l => [l.num, l]));

  let loading = true;
  let errorMessage = '';
  let roles = [];
  let connections = [];
  let databasesByConn = {};
  let roleId = null;
  let roleDetail = null;
  let roleTab = 'databases';
  let showAddRule = false;
  let showNewRole = false;
  let opOptions = [];
  let opsDraft = [];
  let newRoleDraft = { name: '', description: '' };
  let saving = false;
  let toast = '';
  let newRule = { conid: '', mode: 'list', names: '', regex: '', level: 'read_content' };
  let allConnections = [];
  let connSel = [];
  let basicDraft = { name: '', description: '' };
  let limitsDraft = { maxRows: 0, timeoutSeconds: 0, allowedHours: '', allowedIps: '' };
  let membersAll = [];
  let newObj = { database_names_list: '', table_names_list: '', table_role: 'read', table_scope: 'tables' };
  let newMask = { database_names_list: '', table_names_list: '', column_names_list: '', column_mask_mode: 'partial' };
  let newFilter = { database_names_list: '', table_names_list: '', column_name: '', filter_operator: '=', user_field: 'login', value_type: 'user' };

  const t = (key, def) => _t(key, { defaultMessage: def });
  const esc = s => String(s ?? '');

  onMount(async () => {
    const [roleResp, connResp] = await Promise.all([
      apiCall('permissions/get-role-list'),
      apiCall('permissions/get-connection-list'),
    ]);
    if (roleResp?.errorMessage || connResp?.errorMessage) {
      errorMessage = roleResp?.errorMessage || connResp?.errorMessage;
    }
    roles = roleResp?.roles ?? [];
    connections = connResp?.connections ?? [];
    // 库清单：给"命中库（预演）"用
    allConnections = connections;
    const optResp = await apiCall('permissions/get-options');
    opOptions = optResp?.operationPermissions ?? [];
    const allUsersResp = await apiCall('permissions/get-user-list');
    membersAll = allUsersResp?.users ?? [];
    for (const c of connections) {
      const r = await apiCall('server-connections/list-databases', { conid: c.conid });
      const list = (r?.databases ?? []).map(x => (typeof x === 'string' ? { name: x } : x)).filter(x => x?.name);
      databasesByConn = { ...databasesByConn, [c.conid]: list.length ? list : c.defaultDatabase ? [{ name: c.defaultDatabase }] : [] };
    }
    loading = false;
    const editable = roles.filter(r => !r.builtin)[0] ?? roles[0];
    if (editable) await selectRole(editable.id);
  });

  async function selectRole(id) {
    roleId = id;
    errorMessage = '';
    const resp = await apiCall('permissions/get-role-detail', { roleId: id });
    if (resp?.errorMessage) {
      errorMessage = resp.errorMessage;
      return;
    }
    // ★ get-role-detail 把 databases/tables/columns/rowFilters 放在 role 的**同级**，不是 role 里面
    roleDetail = resp ?? null;
    const r0 = roleDetail?.role ?? {};
    basicDraft = { name: r0.name ?? '', description: r0.description ?? '' };
    limitsDraft = { maxRows: r0.limits?.maxRows ?? 0, timeoutSeconds: r0.limits?.timeoutSeconds ?? 0, allowedHours: r0.limits?.allowedHours ?? '', allowedIps: r0.limits?.allowedIps ?? '' };
    connSel = (roleDetail?.connections ?? []).map(x => x.connection_id);
    opsDraft = (roleDetail?.role?.permissions ?? []).filter(p => !String(p).startsWith('~'));
  }

  const connById = id => connections.find(c => c.conid === id);
  const connName = id => (id === '*' ? null : connById(id)?.name ?? id);
  $: allDbs = Object.entries(databasesByConn).flatMap(([conid, list]) => list.map(d => ({ conid, db: d.name })));

  // 与原型 matchDbRule 同一语义：all / 名单(逗号或换行分隔) / 正则
  function matchDbRule(rule, conid, db) {
    if (rule.connection_id && rule.connection_id !== '*' && rule.connection_id !== conid) return false;
    if (rule.database_names_regex) {
      try {
        return new RegExp(rule.database_names_regex, 'i').test(String(db));
      } catch (e) {
        return false;
      }
    }
    const list = String(rule.database_names_list || '')
      .split(/[\n,]/)
      .map(x => x.trim().toLowerCase())
      .filter(Boolean);
    if (!list.length) return true; // 空名单 = 全部（与引擎的 all 等价）
    return list.includes(String(db).toLowerCase());
  }
  function hitDbs(rule) {
    return allDbs.filter(d => matchDbRule(rule, d.conid, d.db));
  }
  const levelOfRule = rule => LEVEL_BY_NUM[rule.database_permission_role_id] ?? LEVELS[0];
  const modeLabel = rule =>
    rule.database_names_regex ? `/${rule.database_names_regex}/i` : (rule.database_names_list || '').trim() ? rule.database_names_list : '*（全部库）';

  $: dbRules = roleDetail?.databases ?? [];
  $: currentRole = roleDetail?.role ?? roles.find(r => r.id === roleId);
  $: memberCount = id => (roleDetail?.members ?? []).filter(m => m.roleId === id).length;

  async function saveRule() {
    if (!roleId) return;
    const body = {
      role_id: roleId,
      connection_id: newRule.conid || '*',
      database_names_list: newRule.mode === 'list' ? newRule.names : '',
      database_names_regex: newRule.mode === 'regex' ? newRule.regex : '',
      database_permission_role_id: (LEVELS.find(l => l.id === newRule.level) ?? LEVELS[2]).num,
    };
    saving = true;
    const resp = await apiCall('permissions/save-role-database', body);
    saving = false;
    if (resp?.errorMessage) {
      errorMessage = resp.errorMessage;
      return;
    }
    showAddRule = false;
    toast = `已保存规则：${modeLabel(body)} → ${(LEVELS.find(l => l.id === newRule.level) ?? {}).name}`;
    setTimeout(() => (toast = ''), 2600);
    await selectRole(roleId);
  }

  async function deleteRule(rule) {
    const resp = await apiCall('permissions/delete-role-database', { rowId: rule.id });
    if (resp?.errorMessage) {
      errorMessage = resp.errorMessage;
      return;
    }
    await selectRole(roleId);
  }


  // ---------- 子页动作（全部接已通过 22/22 端到端测试的接口） ----------
  async function call(path, body) {
    const r = await apiCall(path, body);
    if (r?.errorMessage) { errorMessage = r.errorMessage; return false; }
    errorMessage = '';
    return true;
  }
  async function after(m) { if (m) { await selectRole(roleId); toast = '已保存'; setTimeout(() => (toast = ''), 2000); } }

  async function saveBasic() {
    const r = await apiCall('permissions/save-role-detail', { role: { ...(roleDetail?.role ?? {}), id: roleId, name: basicDraft.name, description: basicDraft.description } });
    if (r?.errorMessage) { errorMessage = r.errorMessage; return; }
    await after(true);
  }
  function toggleConn(id) { connSel = connSel.includes(id) ? connSel.filter(x => x !== id) : [...connSel, id]; }
  async function saveConnections() { await after(await call('permissions/set-role-connections', { roleId, connectionIds: connSel })); }

  async function addObj() { await after(await call('permissions/save-role-table', { role_id: roleId, connection_id: '', ...newObj })); newObj = { database_names_list: '', table_names_list: '', table_role: 'read', table_scope: 'tables' }; }
  async function delObj(id) { await after(await call('permissions/delete-role-table', { rowId: id })); }
  async function addMask() { await after(await call('permissions/save-role-column', { role_id: roleId, connection_id: '', ...newMask })); newMask = { database_names_list: '', table_names_list: '', column_names_list: '', column_mask_mode: 'partial' }; }
  async function delMask(id) { await after(await call('permissions/delete-role-column', { rowId: id })); }
  async function addFilter() { await after(await call('permissions/save-role-row-filter', { role_id: roleId, connection_id: '', ...newFilter })); newFilter = { database_names_list: '', table_names_list: '', column_name: '', filter_operator: '=', user_field: 'login', value_type: 'user' }; }
  async function delFilter(id) { await after(await call('permissions/delete-role-row-filter', { rowId: id })); }
  async function saveLimits() {
    const r = await apiCall('permissions/save-role-detail', { role: { ...(roleDetail?.role ?? {}), id: roleId, limits: { ...limitsDraft } } });
    if (r?.errorMessage) { errorMessage = r.errorMessage; return; }
    await after(true);
  }

  const hasRole = u => (u.roles ?? []).includes(roleId);
  async function toggleMember(u) {
    const roles = hasRole(u) ? u.roles.filter(x => x !== roleId) : [...(u.roles ?? []), roleId];
    const r = await apiCall('permissions/save-user-detail', { user: { ...u, roles } });
    if (r?.errorMessage) { errorMessage = r.errorMessage; return; }
    const ul = await apiCall('permissions/get-user-list');
    membersAll = ul?.users ?? [];
  }


  // ---------- 操作权限（写 role.permissions）----------
  const hasOp = p => opsDraft.includes(p);
  function toggleOp(p) { opsDraft = hasOp(p) ? opsDraft.filter(x => x !== p) : [...opsDraft, p]; }
  async function saveOperations() {
    const r = await apiCall('permissions/save-role-detail', {
      role: { ...(roleDetail?.role ?? {}), id: roleId, permissions: [...opsDraft] },
    });
    if (r?.errorMessage) { errorMessage = r.errorMessage; return; }
    await after(true);
  }

  // ---------- 角色 CRUD ----------
  async function createRole() {
    if (!newRoleDraft.name.trim()) { errorMessage = '角色名不能为空'; return; }
    const r = await apiCall('permissions/save-role-detail', { role: { name: newRoleDraft.name.trim(), description: newRoleDraft.description } });
    if (r?.errorMessage) { errorMessage = r.errorMessage; return; }
    showNewRole = false;
    newRoleDraft = { name: '', description: '' };
    const rl = await apiCall('permissions/get-role-list');
    roles = rl?.roles ?? roles;
    const newId = r?.role?.id;
    if (newId) await selectRole(newId);
  }
  async function deleteRole() {
    if (!roleId) return;
    if (currentRole?.builtin) { errorMessage = '内置角色不能删除'; return; }
    if (!confirm(`确定删除角色「${currentRole?.name}」？`)) return;
    const r = await apiCall('permissions/delete-role', { roleId });
    if (r?.errorMessage) { errorMessage = r.errorMessage; return; }
    const rl = await apiCall('permissions/get-role-list');
    roles = rl?.roles ?? [];
    roleDetail = null; roleId = null;
    if (roles[0]) await selectRole(roles[0].id);
  }
  async function duplicateRole() {
    if (!roleDetail) return;
    const strip = rows => (rows ?? []).map(({ id, role_id, ...rest }) => rest);
    const r = await apiCall('permissions/save-role-detail', {
      role: { name: `${roleDetail.role?.name ?? '角色'} 副本`, description: roleDetail.role?.description ?? '', limits: roleDetail.role?.limits },
      connections: { all: false, ids: (roleDetail.connections ?? []).map(x => x.connection_id) },
      databases: strip(roleDetail.databases),
      tables: strip(roleDetail.tables),
      columns: strip(roleDetail.columns),
      rowFilters: strip(roleDetail.rowFilters),
    });
    if (r?.errorMessage) { errorMessage = r.errorMessage; return; }
    const rl = await apiCall('permissions/get-role-list');
    roles = rl?.roles ?? roles;
    if (r?.role?.id) await selectRole(r.role.id);
  }

  // 预演里正则写错会导致 0 个库 —— 原型专门提示这个最常见的配错
  $: regexBroken = showAddRule && newRule.mode === 'regex' && (() => {
    try {
      new RegExp(newRule.regex, 'i');
      return false;
    } catch (e) {
      return true;
    }
  })();
  $: previewHits = showAddRule
    ? allDbs.filter(d =>
        newRule.mode === 'all' ? true : newRule.mode === 'regex' ? (() => { try { return new RegExp(newRule.regex, 'i').test(d.db); } catch (e) { return false; } })() : String(newRule.names || '').split(/[\n,]/).map(x => x.trim().toLowerCase()).filter(Boolean).includes(String(d.db).toLowerCase())
      )
    : [];
</script>

<div class="adminV2" data-testid="AdminV2Roles">
  {#if loading}
    <div class="content"><div class="empty">加载中…</div></div>
  {:else}
    <div class="body">
      <!-- 侧边导航交给 dbgate 自己的左侧菜单渲染，页签内只放内容 -->
      <div class="main">
        <div class="crumb">管理 <span class="sub">› 角色与授权</span></div>
        <div class="content">
          {#if errorMessage}<div class="box" style="border-color:#da363355;color:#ff8b86;margin-bottom:12px">{errorMessage}</div>{/if}

            <div class="split" style="grid-template-columns:270px minmax(0,1fr)">
              <!-- 角色列表 -->
              <div class="card" style="padding:0;overflow:hidden;align-self:start">
                <div class="row between" style="padding:10px 12px;border-bottom:1px solid var(--border)">
                  <strong>角色</strong>
                  <button class="btn sm" on:click={() => (showNewRole = true)} data-testid="AdminV2Roles_newRoleButton">＋ 新建</button>
                </div>
                {#each roles as r (r.id)}
                  <div
                    class="side-item"
                    class:active={r.id === roleId}
                    on:click={() => selectRole(r.id)}
                    on:keydown={e => e.key === 'Enter' && selectRole(r.id)}
                    role="button"
                    tabindex="0"
                    data-testid={`AdminV2Roles_role_${r.id}`}>
                    <span>{r.name}</span>
                    {#if r.builtin}<span class="pill">内置</span>{/if}
                    <span class="badge">{(roleDetail?.members ?? []).length && r.id === roleId ? '' : ''}</span>
                  </div>
                {/each}
              </div>

              <div>
                <div class="card">
                  <div class="row between">
                    <div>
                      <h1>{currentRole?.name ?? ''} {#if currentRole?.builtin}<span class="pill p">内置角色</span>{/if}</h1>
                      <div class="sub">{currentRole?.description ?? ''}</div>
                    </div>
                    <div class="row">
                      {#if !currentRole?.builtin}
                        <button class="btn sm danger" on:click={deleteRole} data-testid="AdminV2Roles_deleteRole">删除</button>
                      {/if}
                      <button class="btn sm" on:click={duplicateRole} data-testid="AdminV2Roles_duplicateRole">复制为新角色</button>
                    </div>
                  </div>
                  <div class="divider"></div>
                  <div class="pills">
                    {#each ROLE_TABS as [id, name] (id)}
                      <div class="p" class:active={roleTab === id} on:click={() => (roleTab = id)}
                        on:keydown={e => e.key === 'Enter' && (roleTab = id)} role="button" tabindex="0">{name}</div>
                    {/each}
                  </div>
                  <div style="margin-top:14px">
                    {#if roleTab === 'databases'}
                      <!-- ★ 照原型：规则表 + 命中库预演 -->
                      <div class="row between" style="margin-bottom:10px">
                        <div class="sub">
                          在已授权连接内，逐个库 / 用名称列表 / 正则分配档位。<strong>未命中任何规则 = 无权限</strong>（默认拒绝）。同一连接里后面的规则覆盖前面的。
                        </div>
                        <button class="btn sm primary" on:click={() => (showAddRule = true)} data-testid="AdminV2Roles_addDbRule">
                          ＋ 添加数据库规则
                        </button>
                      </div>

                      {#if dbRules.length}
                        <table class="tbl">
                          <thead>
                            <tr><th>连接</th><th>匹配</th><th>档位</th><th>命中库（预演）</th><th></th></tr>
                          </thead>
                          <tbody>
                            {#each dbRules as rule (rule.id)}
                              <tr data-testid={`AdminV2Roles_dbRule_${rule.id}`}>
                                <td>{connName(rule.connection_id) ?? (rule.connection_id === '*' ? '全部连接' : rule.connection_id)}</td>
                                <td class="mono">{modeLabel(rule)}</td>
                                <td>
                                  <span class="lv {levelOfRule(rule).cls}"><span class="lv-dot"></span>{levelOfRule(rule).name}</span>
                                </td>
                                <td class="sub mono">
                                  {#if hitDbs(rule).length}
                                    {hitDbs(rule).map(h => h.db).join('、')}
                                  {:else}
                                    <span class="pill r">0 个</span>
                                  {/if}
                                </td>
                                <td>
                                  <button class="btn sm ghost danger" on:click={() => deleteRule(rule)} data-testid={`AdminV2Roles_delRule_${rule.id}`}>删除</button>
                                </td>
                              </tr>
                            {/each}
                          </tbody>
                        </table>
                      {:else}
                        <div class="empty">
                          还没有数据库规则，这个角色目前<strong>看不到任何库</strong>。<br />
                          <button class="btn sm primary" style="margin-top:10px" on:click={() => (showAddRule = true)}>立即添加</button>
                        </div>
                      {/if}
                      <div class="hint" style="margin-top:10px">
                        预演列会实时算出规则命中的库，避免"正则写错导致 0 个库"这种最常见的配错。
                      </div>
                    {:else if roleTab === 'basic'}
  <div class="field"><div class="lb">角色名</div><div class="ctl"><input type="text" bind:value={basicDraft.name} data-testid="AdminV2Roles_basicName" /></div></div>
  <div class="field top"><div class="lb">说明</div><div class="ctl"><input type="text" bind:value={basicDraft.description} /></div></div>
  <div class="row"><button class="btn sm primary" on:click={saveBasic} data-testid="AdminV2Roles_basicSave">保存</button></div>
{:else if roleTab === 'connections'}
  <div class="sub" style="margin-bottom:8px">连接是前提：没勾的连接，库里配了规则也看不到。</div>
  <div class="checks">
    {#each allConnections as c (c.conid)}
      <label class="row" style="gap:6px"><input type="checkbox" checked={connSel.includes(c.conid)} on:change={() => toggleConn(c.conid)} /> {c.name}</label>
    {/each}
  </div>
  <div class="row" style="margin-top:12px"><button class="btn sm primary" on:click={saveConnections} data-testid="AdminV2Roles_connSave">保存连接</button></div>
{:else if roleTab === 'objects'}
  <div class="sub" style="margin-bottom:8px">对象级：在已放行的库内，对表/视图/存储过程/函数单独授权（未命中 = 跟随库级）。</div>
  <table class="tbl"><thead><tr><th>库</th><th>对象</th><th>范围</th><th>档位</th><th></th></tr></thead><tbody>
    {#each roleDetail?.tables ?? [] as t (t.id)}
      <tr><td class="mono">{t.database_names_list || t.database_names_regex || "*"}</td><td class="mono">{t.table_names_list || t.table_names_regex || "*"}</td>
        <td>{t.table_permission_scope_id === -2 ? "表" : t.table_permission_scope_id === -3 ? "视图" : t.table_permission_scope_id === -4 ? "存储过程" : t.table_permission_scope_id === -5 ? "函数" : "全部对象"}</td>
        <td>{t.table_permission_role_id === -1 ? "只读" : t.table_permission_role_id === -2 ? "可改数据" : t.table_permission_role_id === -3 ? "可增删改" : t.table_permission_role_id === -4 ? "可执行" : "拒绝"}</td>
        <td><button class="btn sm ghost danger" on:click={() => delObj(t.id)}>删除</button></td></tr>
    {/each}
    {#if !(roleDetail?.tables ?? []).length}<tr><td colspan="5" class="sub">还没有对象级规则</td></tr>{/if}
  </tbody></table>
  <div class="box"><div class="row wrap">
    <input type="text" placeholder="库名（空=全部）" bind:value={newObj.database_names_list} style="width:150px" />
    <input type="text" placeholder="对象名（逗号分隔）" bind:value={newObj.table_names_list} style="width:200px" />
    <select bind:value={newObj.table_scope}><option value="tables">表</option><option value="views">视图</option><option value="procedures">存储过程</option><option value="functions">函数</option><option value="all_objects">全部对象</option></select>
    <select bind:value={newObj.table_role}><option value="read">只读</option><option value="update_only">可改数据</option><option value="create_update_delete">可增删改</option><option value="run_script">可执行</option><option value="deny">拒绝</option></select>
    <button class="btn sm primary" on:click={addObj} data-testid="AdminV2Roles_addObj">＋ 添加对象规则</button>
  </div></div>
{:else if roleTab === 'operations'}
  <div class="sub" style="margin-bottom:10px">这个角色能用哪些操作。关掉 = 显式拒绝；涉及行过滤/列脱敏的项保存时会被自动关闭。</div>
  {#each opOptions as op (op.key)}
    <div class="row" style="padding:5px 4px;gap:8px">
      <input type="checkbox" checked={hasOp(op.permission)} on:change={() => toggleOp(op.permission)} data-testid={`AdminV2Roles_op_${op.key}`} />
      <div><div style="font-size:12.5px">{op.defaultLabel}</div><div class="hint" style="font-size:11px">{op.permission}</div></div>
    </div>
  {/each}
  <div class="row" style="margin-top:12px"><button class="btn sm primary" on:click={saveOperations} data-testid="AdminV2Roles_saveOps">保存操作权限</button></div>
  <div class="hint" style="margin-top:8px">当前已开 {opsDraft.length} 项 / 共 {opOptions.length} 项。</div>
{:else if roleTab === 'advanced'}
  <h2 style="font-size:13px">行级过滤（按成员字段过滤行）</h2>
  <table class="tbl"><thead><tr><th>库</th><th>表</th><th>条件</th><th></th></tr></thead><tbody>
    {#each roleDetail?.rowFilters ?? [] as f (f.id)}
      <tr><td class="mono">{f.database_names_list || "*"}</td><td class="mono">{f.table_names_list || "*"}</td>
        <td class="mono">{f.column_name} {f.filter_operator} ${{"user": "${user." + f.user_field + "}", "literal": f.literal_value}[f.value_type] || f.user_field}</td>
        <td><button class="btn sm ghost danger" on:click={() => delFilter(f.id)}>删除</button></td></tr>
    {/each}
    {#if !(roleDetail?.rowFilters ?? []).length}<tr><td colspan="4" class="sub">没有行过滤</td></tr>{/if}
  </tbody></table>
  <div class="box"><div class="row wrap">
    <input type="text" placeholder="表名" bind:value={newFilter.table_names_list} style="width:150px" />
    <input type="text" placeholder="列名 tenant_id" bind:value={newFilter.column_name} style="width:150px" />
    <select bind:value={newFilter.filter_operator}>{#each ["=", "!=", ">", ">=", "<", "<="] as op (op)}<option value={op}>{op}</option>{/each}</select>
    <select bind:value={newFilter.user_field}>{#each ["id", "login", "name", "email", "tenant", "connectUserId"] as f (f)}<option value={f}>{f}</option>{/each}</select>
    <button class="btn sm primary" on:click={addFilter} data-testid="AdminV2Roles_addFilter">＋ 添加行过滤</button>
  </div></div>
  <h2 style="font-size:13px;margin-top:16px">列级脱敏 / 隐藏</h2>
  <table class="tbl"><thead><tr><th>库</th><th>表</th><th>列</th><th>方式</th><th></th></tr></thead><tbody>
    {#each roleDetail?.columns ?? [] as c (c.id)}
      <tr><td class="mono">{c.database_names_list || "*"}</td><td class="mono">{c.table_names_list || "*"}</td><td class="mono">{c.column_names_list}</td>
        <td>{c.column_mask_mode === "hide" ? "隐藏" : "部分脱敏"}</td>
        <td><button class="btn sm ghost danger" on:click={() => delMask(c.id)}>删除</button></td></tr>
    {/each}
    {#if !(roleDetail?.columns ?? []).length}<tr><td colspan="5" class="sub">没有列脱敏</td></tr>{/if}
  </tbody></table>
  <div class="box"><div class="row wrap">
    <input type="text" placeholder="表名" bind:value={newMask.table_names_list} style="width:150px" />
    <input type="text" placeholder="列名 phone,id_card" bind:value={newMask.column_names_list} style="width:200px" />
    <select bind:value={newMask.column_mask_mode}><option value="partial">部分脱敏</option><option value="hide">隐藏</option></select>
    <button class="btn sm primary" on:click={addMask} data-testid="AdminV2Roles_addMask">＋ 添加脱敏</button>
  </div></div>
  <h2 style="font-size:13px;margin-top:16px">使用限制</h2>
  <div class="row wrap">
    <input type="number" min="0" bind:value={limitsDraft.maxRows} style="width:110px" placeholder="最大行数" />
    <input type="number" min="0" bind:value={limitsDraft.timeoutSeconds} style="width:110px" placeholder="超时秒" />
    <input type="text" bind:value={limitsDraft.allowedHours} style="width:150px" placeholder="09:00-18:00" />
    <input type="text" bind:value={limitsDraft.allowedIps} style="width:150px" placeholder="10.20." />
    <button class="btn sm primary" on:click={saveLimits} data-testid="AdminV2Roles_saveLimits">保存限制</button>
  </div>
{:else if roleTab === 'members'}
  <div class="sub" style="margin-bottom:8px">勾上 = 该成员拥有这个角色（直接写成员的角色列表）。</div>
  <table class="tbl"><thead><tr><th>成员</th><th>登录名</th><th>拥有</th></tr></thead><tbody>
    {#each membersAll as u (u.id)}
      <tr><td>{u.name || u.login}</td><td class="mono">{u.login}</td>
        <td><input type="checkbox" checked={hasRole(u)} on:change={() => toggleMember(u)} data-testid={`AdminV2Roles_member_${u.id}`} /></td></tr>
    {/each}
  </tbody></table>
{/if}
                  </div>
                </div>
              </div>
            </div>
          </div>
      </div>
    </div>
  {/if}

  <!-- 添加规则（弹窗，照原型 modal） -->
  {#if showAddRule}
    <div class="modal-mask" role="presentation">
      <div class="modal" data-testid="AdminV2Roles_addRuleModal">
        <div class="modal-head"><span class="t">添加数据库规则</span></div>
        <div class="modal-body">
          <div class="field">
            <div class="lb">连接</div>
            <div class="ctl">
              <select bind:value={newRule.conid} style="width:100%" data-testid="AdminV2Roles_conSelect">
                <option value="">全部连接</option>
                {#each connections as c (c.conid)}<option value={c.conid}>{c.name}</option>{/each}
              </select>
            </div>
          </div>
          <div class="field">
            <div class="lb">匹配方式</div>
            <div class="ctl">
              <select bind:value={newRule.mode} style="width:100%" data-testid="AdminV2Roles_modeSelect">
                <option value="all">全部库</option>
                <option value="list">名称列表</option>
                <option value="regex">正则</option>
              </select>
            </div>
          </div>
          {#if newRule.mode === 'list'}
            <div class="field top">
              <div class="lb">库名列表</div>
              <div class="ctl">
                <input type="text" bind:value={newRule.names} placeholder="order_db, log_db" data-testid="AdminV2Roles_names" />
                <div class="hint" style="margin-top:6px">逗号或换行分隔，忽略大小写。</div>
              </div>
            </div>
          {:else if newRule.mode === 'regex'}
            <div class="field top">
              <div class="lb">库名正则</div>
              <div class="ctl">
                <input type="text" bind:value={newRule.regex} placeholder="^mp_(cd|sh)$" data-testid="AdminV2Roles_regex" />
                {#if regexBroken}<div class="hint" style="color:#ff8b86;margin-top:6px">正则语法有误，会命中 0 个库。</div>{/if}
              </div>
            </div>
          {/if}
          <div class="field">
            <div class="lb">档位</div>
            <div class="ctl">
              <select bind:value={newRule.level} style="width:100%" data-testid="AdminV2Roles_levelSelect">
                {#each LEVELS as l (l.id)}<option value={l.id}>{l.name}</option>{/each}
              </select>
            </div>
          </div>
          <div class="box">
            <div class="sub" style="margin-bottom:6px">命中库（预演）</div>
            {#if previewHits.length}
              <div class="mono">
                {previewHits.slice(0, 24).map(h => h.db).join('、')}{previewHits.length > 24 ? ` …共 ${previewHits.length} 个` : ''}
              </div>
            {:else}
              <span class="pill r">0 个库</span> <span class="sub">—— 这条规则实际不会放行任何库</span>
            {/if}
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn sm" on:click={() => (showAddRule = false)}>取消</button>
          <button class="btn sm primary" on:click={saveRule} disabled={saving} data-testid="AdminV2Roles_saveRule">保存</button>
        </div>
      </div>
    </div>
  {/if}

  {#if showNewRole}
    <div class="modal-mask" role="presentation">
      <div class="modal" data-testid="AdminV2Roles_newRoleModal">
        <div class="modal-head"><span class="t">新建角色</span></div>
        <div class="modal-body">
          <div class="field"><div class="lb">角色名</div><div class="ctl">
            <input type="text" bind:value={newRoleDraft.name} placeholder="例如：订单库只读" data-testid="AdminV2Roles_newRoleName" style="width:100%" /></div></div>
          <div class="field top"><div class="lb">说明</div><div class="ctl">
            <input type="text" bind:value={newRoleDraft.description} placeholder="这个角色能做什么" style="width:100%" /></div></div>
          <div class="hint">新建后到「连接」「数据库」子页给它配权限；不配就是无权限（默认拒绝）。</div>
        </div>
        <div class="modal-foot">
          <button class="btn sm" on:click={() => (showNewRole = false)}>取消</button>
          <button class="btn sm primary" on:click={createRole} data-testid="AdminV2Roles_newRoleSave">创建</button>
        </div>
      </div>
    </div>
  {/if}
  {#if toast}<div class="toast"><div class="t">{toast}</div></div>{/if}
</div>

<!-- 原型自带的样式，整段照搬（Svelte 会做作用域隔离，不会污染应用全局） -->
<style>
  .adminV2 {
    --rail: #15181d;
    --side: #1b1f26;
    --bg: #21252c;
    --panel: #262b33;
    --panel2: #2c323c;
    --border: #383f4a;
    --text: #e8ebf1;
    --muted: #98a2b3;
    --accent: #2f86e0;
    --accent2: #2268b4;
    --green: #2ea043;
    --amber: #d29922;
    --red: #da3633;
    --purple: #8957e5;
    --slate: #6b7686;
    --radius: 6px;
    --shadow: 0 14px 40px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--bg);
    color: var(--text);
    font: 13px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .adminV2[data-theme='light'] {
    --rail: #e6ebf2;
    --side: #f1f4f8;
    --bg: #f7f9fc;
    --panel: #ffffff;
    --panel2: #eef2f7;
    --border: #d5dbe4;
    --text: #1c2229;
    --muted: #5b6673;
    --shadow: 0 14px 40px rgba(16, 24, 40, 0.15);
  }
  .adminV2 :global(*) {
    box-sizing: border-box;
  }
  .ic {
    width: 18px;
    height: 18px;
    flex: none;
  }
  .ic.sm {
    width: 14px;
    height: 14px;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .side {
    width: 210px;
    flex: none;
    background: var(--side);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .side-head {
    padding: 10px 12px 8px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .side-head .t {
    font-weight: 600;
  }
  .side-body {
    overflow: auto;
    padding: 8px;
    flex: 1;
  }
  .side-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 9px;
    border-radius: var(--radius);
    cursor: pointer;
    color: var(--text);
    border: 1px solid transparent;
  }
  .side-item:hover {
    background: var(--panel2);
  }
  .side-item.active {
    background: var(--panel2);
    border-color: var(--border);
    color: var(--accent);
    font-weight: 600;
  }
  .side-item .badge {
    margin-left: auto;
    font-size: 11px;
    color: var(--muted);
  }
  .side-note {
    font-size: 11.5px;
    color: var(--muted);
    padding: 6px 10px;
    line-height: 1.5;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .crumb {
    height: 34px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px;
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
    background: var(--side);
  }
  .content {
    flex: 1;
    overflow: auto;
    padding: 16px;
  }
  h1 {
    font-size: 17px;
    margin: 0 0 2px;
  }
  .sub {
    color: var(--muted);
    font-size: 12px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .between {
    justify-content: space-between;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px;
  }
  .divider {
    height: 1px;
    background: var(--border);
    margin: 12px 0;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    border-radius: var(--radius);
    background: var(--panel2);
    border: 1px solid var(--border);
    cursor: pointer;
    white-space: nowrap;
    color: inherit;
    font: inherit;
  }
  .btn:hover {
    border-color: var(--accent);
  }
  .btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .btn.primary:hover {
    background: var(--accent2);
  }
  .btn.ghost {
    background: transparent;
  }
  .btn.danger {
    color: #ff8b86;
    border-color: #da363355;
  }
  .btn.sm {
    padding: 3px 8px;
    font-size: 12px;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11.5px;
    background: var(--panel2);
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .pill.p {
    color: #c3a6ff;
    border-color: #8957e555;
    background: #8957e514;
  }
  .pill.r {
    color: #ff8b86;
    border-color: #da363355;
    background: #da363314;
  }
  table.tbl {
    width: 100%;
    border-collapse: collapse;
  }
  table.tbl th,
  table.tbl td {
    text-align: left;
    padding: 7px 9px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  table.tbl th {
    color: var(--muted);
    font-weight: 600;
    font-size: 12px;
    background: var(--panel2);
    position: sticky;
    top: 0;
    z-index: 1;
  }
  .empty {
    padding: 22px;
    text-align: center;
    color: var(--muted);
    border: 1px dashed var(--border);
    border-radius: 8px;
  }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
  }
  .hint {
    color: var(--muted);
    font-size: 11.5px;
    line-height: 1.6;
  }
  .box {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    background: var(--panel2);
    margin-top: 10px;
  }
  .pills {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .pills .p {
    padding: 4px 11px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--panel2);
    cursor: pointer;
    font-size: 12.5px;
  }
  .pills .p.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .lv {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 11.5px;
    border: 1px solid;
    white-space: nowrap;
  }
  .lv-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
  }
  .lv-deny {
    color: #8b95a3;
    border-color: #6b768655;
    background: #6b768618;
  }
  .lv-deny .lv-dot {
    background: #6b7686;
  }
  .lv-view {
    color: #a9b4c4;
    border-color: #8b95a355;
    background: #8b95a318;
  }
  .lv-view .lv-dot {
    background: #a9b4c4;
  }
  .lv-read {
    color: #6fdc8c;
    border-color: #2ea04355;
    background: #2ea04318;
  }
  .lv-read .lv-dot {
    background: #2ea043;
  }
  .lv-write {
    color: #7cc0ff;
    border-color: #2f86e055;
    background: #2f86e018;
  }
  .lv-write .lv-dot {
    background: #2f86e0;
  }
  .lv-script {
    color: #c3a6ff;
    border-color: #8957e555;
    background: #8957e518;
  }
  .lv-script .lv-dot {
    background: #8957e5;
  }
  .split {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    gap: 14px;
  }
  .modal-mask {
    position: fixed;
    inset: 0;
    background: #000000a8;
    display: grid;
    place-items: center;
    z-index: 50;
  }
  .modal {
    width: min(680px, 94vw);
    max-height: 88vh;
    overflow: auto;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: var(--shadow);
  }
  .modal-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--panel);
  }
  .modal-head .t {
    font-weight: 600;
  }
  .modal-body {
    padding: 14px;
  }
  .modal-foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 14px;
    border-top: 1px solid var(--border);
    position: sticky;
    bottom: 0;
    background: var(--panel);
  }
  .field {
    display: grid;
    grid-template-columns: 132px 1fr;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }
  .field.top {
    align-items: start;
  }
  .field .lb {
    color: var(--muted);
    font-size: 12.5px;
  }
  .field .ctl {
    min-width: 0;
  }
  .toast {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 90;
  }
  .toast .t {
    background: var(--panel);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 8px;
    padding: 9px 12px;
    box-shadow: var(--shadow);
    font-size: 12.5px;
    max-width: 380px;
  }
  select,
  input[type='text'] {
    font: inherit;
    color: var(--text);
    background: var(--panel2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 5px 8px;
    outline: none;
  }
  select:focus,
  input[type='text']:focus {
    border-color: var(--accent);
  }
</style>
