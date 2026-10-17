<script lang="ts">
  import { onMount } from 'svelte';
  import { apiCall } from '../utility/api';
  import { _t } from '../translations';

  // 原型 section「审计日志」：谁在什么时候改了什么（社区版自带 changeLog，不依赖 Premium 审计）
  export const matchingProps = [];

  let loading = true;
  let errorMessage = '';
  let entries = [];

  const t = (key, def) => _t(key, { defaultMessage: def });

  onMount(load);

  async function load() {
    loading = true;
    const resp = await apiCall('permissions/get-change-log', { limit: 200 });
    if (resp?.errorMessage) errorMessage = resp.errorMessage;
    entries = resp?.entries ?? [];
    loading = false;
  }

  const fmt = iso => {
    if (!iso) return '—';
    const d = new Date(iso);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const ACTION_LABEL = {
    'grant.database': '库授权',
    'grant.database.delete': '取消库授权',
    'grant.operations': '操作权限',
    'grant.limits': '使用限制',
    'user.save': '成员保存',
    'user.delete': '成员删除',
    'role.save': '角色保存',
    'role.delete': '角色删除',
  };
</script>

<div class="adminV2" data-testid="AdminAuditTab">
  <div class="row between">
    <h2>审计日志 <span class="sub">共 {entries.length} 条（最近 500 条内）</span></h2>
    <button class="btn" on:click={load} data-testid="AdminAuditTab_refresh">刷新</button>
  </div>
  {#if loading}
    <div class="empty">加载中…</div>
  {:else if errorMessage}
    <div class="err">{errorMessage}</div>
  {:else if !entries.length}
    <div class="empty">
      还没有变更记录。<br />
      <span class="hint">在「角色与授权」里加一条数据库规则、或在「用户」里改一次角色，这里就会出现记录。</span>
    </div>
  {:else}
    <table class="tbl" data-testid="AdminAuditTab_table">
      <thead><tr><th style="width:170px">时间</th><th style="width:110px">动作</th><th style="width:200px">对象</th><th>详情</th><th style="width:160px">操作人</th></tr></thead>
      <tbody>
        {#each entries as e (e.id)}
          <tr>
            <td class="mono">{fmt(e.at)}</td>
            <td><span class="pill">{ACTION_LABEL[e.action] ?? e.action}</span></td>
            <td>{e.target || '—'}</td>
            <td class="mono">{e.detail || '—'}</td>
            <td class="sub">{e.actor || '—'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
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
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .between {
    justify-content: space-between;
    margin-bottom: 12px;
  }
  h2 {
    font-size: 14px;
    margin: 0;
  }
  .sub {
    color: var(--muted);
    font-size: 12px;
    font-weight: 400;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: var(--radius);
    background: var(--panel2);
    border: 1px solid var(--border);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .btn:hover {
    border-color: var(--accent);
  }
  table.tbl {
    width: 100%;
    border-collapse: collapse;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
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
  }
  .pill {
    display: inline-flex;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11.5px;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
  }
  .hint {
    color: var(--muted);
    font-size: 11.5px;
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
