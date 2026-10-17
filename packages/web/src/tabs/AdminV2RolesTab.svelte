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
  let saving = false;
  let toast = '';
  let newRule = { conid: '', mode: 'list', names: '', regex: '', level: 'read_content' };

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
    const resp = await apiCall('permissions/delete-role-database', { roleId, ruleId: rule.id });
    if (resp?.errorMessage) {
      errorMessage = resp.errorMessage;
      return;
    }
    await selectRole(roleId);
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
                  <button class="btn sm" data-testid="AdminV2Roles_newRoleButton">＋ 新建</button>
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
                    <div class="row"><button class="btn sm">复制为新角色</button></div>
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
                    {:else}
                      <div class="empty">
                        「{ROLE_TABS.find(x => x[0] === roleTab)?.[1]}」子页按原型实现中。
                      </div>
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
