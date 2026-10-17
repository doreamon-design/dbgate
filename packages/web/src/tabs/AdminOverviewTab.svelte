<script lang="ts">
  import { onMount } from 'svelte';
  import { apiCall } from '../utility/api';
  import { _t } from '../translations';

  // 原型 section「概览」：一眼看清现状 + 待处理 + 建议下一步
  export const matchingProps = [];

  let loading = true;
  let errorMessage = '';
  let summary = null;
  let members = [];
  let connections = [];

  const t = (key, def) => _t(key, { defaultMessage: def });

  onMount(async () => {
    const [s, u, c] = await Promise.all([
      apiCall('permissions/get-summary'),
      apiCall('permissions/get-user-list'),
      apiCall('permissions/get-connection-list'),
    ]);
    errorMessage = s?.errorMessage || u?.errorMessage || c?.errorMessage || '';
    summary = s ?? null;
    members = u?.users ?? [];
    connections = c?.connections ?? [];
    loading = false;
  });

  const READONLY_ROLES = ['unassigned', 'legacy-all'];
  $: noRoles = members.filter(m => !(m.roles ?? []).some(r => !READONLY_ROLES.includes(r)));
  $: disabled = members.filter(m => m.status === 'disabled');
  $: expiring = members.filter(m => m.expires && new Date(m.expires).getTime() - Date.now() < 30 * 86400 * 1000);
</script>

<div class="adminV2" data-testid="AdminOverviewTab">
  {#if loading}
    <div class="empty">加载中…</div>
  {:else if errorMessage}
    <div class="err">{errorMessage}</div>
  {:else}
    <div class="grid k4">
      <div class="card stat"><div class="v">{summary?.users ?? members.length}</div><div class="l">成员</div></div>
      <div class="card stat"><div class="v">{summary?.roles ?? '—'}</div><div class="l">角色</div></div>
      <div class="card stat"><div class="v">{summary?.connections ?? connections.length}</div><div class="l">连接</div></div>
      <div class="card stat"><div class="v">{summary?.databases ?? '—'}</div><div class="l">已登记库</div></div>
    </div>

    <div class="split">
      <div class="card">
        <h2>待处理</h2>
        {#if !noRoles.length && !disabled.length && !expiring.length}
          <div class="empty">没有待处理事项</div>
        {:else}
          <table class="tbl">
            <thead><tr><th>对象</th><th>问题</th><th></th></tr></thead>
            <tbody>
              {#each noRoles as m (m.id)}
                <tr><td>{m.name || m.login}</td><td><span class="pill a">还没分配任何角色</span></td><td class="sub">他没有权限，登录后看不到任何库</td></tr>
              {/each}
              {#each disabled as m (m.id)}
                <tr><td>{m.name || m.login}</td><td><span class="pill r">已停用</span></td><td class="sub">停用后无法登录</td></tr>
              {/each}
              {#each expiring as m (m.id)}
                <tr><td>{m.name || m.login}</td><td><span class="pill a">即将过期</span></td><td class="sub">{m.expires}</td></tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
      <div class="card">
        <h2>建议的下一步</h2>
        <div class="kv">
          <div class="k">① 建角色</div><div>到「角色与授权」新建角色，配好连接与库档位</div>
          <div class="k">② 配库规则</div><div>在角色内加数据库规则（全部 / 名单 / 正则），看命中库预演</div>
          <div class="k">③ 分配成员</div><div>到「用户」把角色挂给成员</div>
          <div class="k">④ 核对</div><div>用「权限预览」确认他只能看到该看的</div>
        </div>
        <div class="divider"></div>
        <div class="hint">
          默认拒绝：连接授权只是前提，库和对象没有命中规则就是无权限。任何角色显式
          <span class="mono">拒绝</span> 后，其它角色不能再把它放回来。
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .adminV2 {
    --bg: #21252c;
    --panel: #262b33;
    --panel2: #2c323c;
    --border: #383f4a;
    --text: #e8ebf1;
    --muted: #98a2b3;
    --accent: #2f86e0;
    --radius: 6px;
    background: var(--bg);
    color: var(--text);
    height: 100%;
    overflow: auto;
    padding: 16px;
    font: 13px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  }
  .grid.k4 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: 12px;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px;
  }
  .card + .card,
  .grid + .split {
    margin-top: 14px;
  }
  .split {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
    gap: 14px;
    margin-top: 14px;
    align-items: start;
  }
  h2 {
    font-size: 14px;
    margin: 0 0 10px;
  }
  .stat .v {
    font-size: 22px;
    font-weight: 700;
  }
  .stat .l {
    color: var(--muted);
    font-size: 12px;
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
  }
  table.tbl th {
    color: var(--muted);
    font-weight: 600;
    font-size: 12px;
    background: var(--panel2);
  }
  .pill {
    display: inline-flex;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11.5px;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .pill.a {
    color: #ffd479;
    border-color: #d2992255;
    background: #d2992214;
  }
  .pill.r {
    color: #ff8b86;
    border-color: #da363355;
    background: #da363314;
  }
  .kv {
    display: grid;
    grid-template-columns: 92px 1fr;
    gap: 6px 10px;
    font-size: 12.5px;
  }
  .kv .k {
    color: var(--muted);
  }
  .divider {
    height: 1px;
    background: var(--border);
    margin: 12px 0;
  }
  .hint {
    color: var(--muted);
    font-size: 11.5px;
    line-height: 1.6;
  }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
  }
  .empty {
    padding: 22px;
    text-align: center;
    color: var(--muted);
    border: 1px dashed var(--border);
    border-radius: 8px;
  }
  .err {
    color: #ff8b86;
    border: 1px solid #da363355;
    border-radius: 8px;
    padding: 8px 10px;
  }
</style>
