<script lang="ts">
  import { onMount } from 'svelte';
  import { apiCall } from '../utility/api';
  import './adminPages.css';

  // 原型 section「权限预览 / 模拟」：以某个成员身份看他能看到什么 + 被拒绝什么
  export const matchingProps = [];
  let users = [], userId = '', access = null, visibility = null, loading = true, errorMessage = '';

  onMount(async () => {
    const r = await apiCall('permissions/get-user-list');
    users = r?.users ?? [];
    if (users[0]) { userId = users[0].id; await load(); }
    loading = false;
  });
  async function load() {
    if (!userId) return;
    errorMessage = '';
    const [a, v] = await Promise.all([
      apiCall('permissions/get-user-access', { userId }),
      apiCall('permissions/get-user-visibility', { userId }),
    ]);
    if (a?.errorMessage) errorMessage = a.errorMessage;
    access = a ?? null;
    visibility = v ?? null;
  }
  const LV = { deny: '无权限', view: '可见', read_content: '只读', write_data: '可写', run_script: '可执行' };
  const lvName = v => LV[v] ?? v ?? '—';
  $: conns = visibility?.connections ?? visibility?.databases ?? [];
</script>

<div class="aP" data-testid="AdminPreviewPage">
  {#if loading}
    <div class="aP-empty">加载中…</div>
  {:else}
    {#if errorMessage}<div class="aP-err">{errorMessage}</div>{/if}
    <div class="aP-card">
      <div class="aP-h"><h2>权限预览 / 模拟</h2>
        <select bind:value={userId} on:change={load} data-testid="AdminPreviewPage_userSelect">
          {#each users as u (u.id)}<option value={u.id}>{u.name || u.login}</option>{/each}
        </select>
      </div>
      <div class="aP-sub">以该成员身份看：他实际能打开哪些库/表，以及哪些能力被明确禁止。</div>
    </div>

    <div class="aP-grid" style="margin-top:14px">
      <div class="aP-card">
        <div class="aP-h"><h2 style="font-size:13px">他看得到的连接与库</h2></div>
        {#if conns.length}
          <div class="aP-tree">
            {#each conns as c (c.conid ?? c.connection ?? c.name)}
              <div class="n conn">{c.name ?? c.conid ?? c.connection}</div>
              {#each c.databases ?? [] as d (d.database ?? d.name)}
                <div class="n db">{d.database ?? d.name}
                  <span class="aP-pill {d.level === 'deny' ? 'r' : 'g'}">{lvName(d.level)}</span></div>
                {#each d.tables ?? [] as t (t.table ?? t.name)}
                  <div class="n tab">· {t.table ?? t.name}
                    {#if t.columnMasks?.length}<span class="aP-pill a">列脱敏</span>{/if}
                    {#if t.rowFilter}<span class="aP-pill a">行过滤</span>{/if}
                  </div>
                {/each}
              {/each}
            {/each}
          </div>
        {:else}
          <div class="aP-empty">他看不到任何连接（没有授权）</div>
        {/if}
      </div>

      <div class="aP-card">
        <div class="aP-h"><h2 style="font-size:13px">他被明确禁止 / 受限的事</h2></div>
        <table class="aP-tbl">
          <tbody>
            <tr><td>生效角色</td><td>{(access?.roles ?? []).map(r => r.name ?? r.id).join('、') || '—'}</td></tr>
            <tr><td>裸 SQL（会绕过行过滤）</td><td>{access?.restrictions?.rawSqlBlocked ? '禁止' : '允许'}</td></tr>
            <tr><td>批量导出（列脱敏未覆盖）</td><td>{access?.restrictions?.bulkExportBlocked ? '禁止' : '允许'}</td></tr>
            <tr><td>状态</td><td>{access?.disabled ? '已停用' : access?.expired ? '已过期' : '正常'}</td></tr>
          </tbody>
        </table>
        {#if !(access?.restrictions?.rawSqlBlocked || access?.restrictions?.bulkExportBlocked)}
          <div class="aP-sub" style="margin-top:8px">没有额外限制。若要限制，请在角色里配行过滤 / 列脱敏。</div>
        {/if}
      </div>
    </div>
  {/if}
</div>
