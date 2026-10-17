<script lang="ts">
  import { onMount } from 'svelte';
  import { apiCall } from '../utility/api';
  import './adminPages.css';

  // 原型 section「访问矩阵」：按库看各角色档位 + 各成员最终结果（成员列只读）
  export const matchingProps = [];
  let connections = [], databases = {}, conid = '', database = '', matrix = null, loading = true, errorMessage = '';

  onMount(async () => {
    const c = await apiCall('permissions/get-connection-list');
    connections = c?.connections ?? [];
    for (const conn of connections) {
      const r = await apiCall('server-connections/list-databases', { conid: conn.conid });
      const list = (r?.databases ?? []).map(x => (typeof x === 'string' ? { name: x } : x)).filter(x => x?.name);
      databases = { ...databases, [conn.conid]: list.length ? list : conn.defaultDatabase ? [{ name: conn.defaultDatabase }] : [] };
    }
    const first = connections[0];
    if (first) {
      conid = first.conid;
      database = (databases[first.conid] ?? [])[0]?.name ?? '';
      await load();
    }
    loading = false;
  });

  async function load() {
    if (!conid || !database) { matrix = null; return; }
    const r = await apiCall('permissions/get-access-matrix', { conid, database });
    if (r?.errorMessage) errorMessage = r.errorMessage;
    matrix = r ?? null;
  }
  const LV = { deny: '无权限', view: '可见', read_content: '只读', write_data: '可写', run_script: '可执行' };
  const lvName = v => LV[v] ?? v ?? '—';
  const lvCls = v => (v === 'deny' ? 'r' : v === 'view' ? '' : v === 'read_content' ? 'g' : v === 'write_data' ? 'b' : 'a');
</script>

<div class="aP" data-testid="AdminMatrixPage">
  {#if loading}
    <div class="aP-empty">加载中…</div>
  {:else}
    {#if errorMessage}<div class="aP-err">{errorMessage}</div>{/if}
    <div class="aP-card">
      <div class="aP-h"><h2>访问矩阵</h2>
        <div style="display:flex;gap:8px">
          <select bind:value={conid} on:change={() => { database = (databases[conid] ?? [])[0]?.name ?? ''; load(); }}>
            {#each connections as c (c.conid)}<option value={c.conid}>{c.name}</option>{/each}
          </select>
          <select bind:value={database} on:change={load}>
            {#each databases[conid] ?? [] as d (d.name)}<option value={d.name}>{d.name}</option>{/each}
          </select>
        </div>
      </div>
      <div class="aP-sub" style="margin-bottom:10px">角色列可改（点档位），成员列是该成员跨所有角色合并后的最终结果（只读）。</div>

      <div class="aP-grid">
        <div>
          <div class="aP-h"><h2 style="font-size:13px">角色档位</h2></div>
          <table class="aP-tbl">
            <thead><tr><th>角色</th><th>档位</th></tr></thead>
            <tbody>
              {#each matrix?.roles ?? [] as r (r.id ?? r.roleId ?? r.name)}
                <tr><td>{r.name ?? r.roleName ?? r.roleId}</td>
                  <td><span class="aP-pill {lvCls(r.level)}">{lvName(r.level)}</span></td></tr>
              {/each}
              {#if !(matrix?.roles ?? []).length}<tr><td colspan="2" class="aP-sub">该库没有角色规则</td></tr>{/if}
            </tbody>
          </table>
        </div>
        <div>
          <div class="aP-h"><h2 style="font-size:13px">成员最终结果</h2></div>
          <table class="aP-tbl">
            <thead><tr><th>成员</th><th>档位</th></tr></thead>
            <tbody>
              {#each matrix?.users ?? [] as u (u.id ?? u.login)}
                <tr><td>{u.name ?? u.login}</td>
                  <td><span class="aP-pill {lvCls(u.level)}">{lvName(u.level)}</span></td></tr>
              {/each}
              {#if !(matrix?.users ?? []).length}<tr><td colspan="2" class="aP-sub">没有成员</td></tr>{/if}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  {/if}
</div>
