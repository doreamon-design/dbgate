<script lang="ts">
  import { onMount } from 'svelte';
  import { apiCall } from '../utility/api';
  import './adminPages.css';

  // 原型 section「用户」：成员列表 + 编辑（登录名/显示名/租户/有效期/状态/角色）
  export const matchingProps = [];
  let users = [], roles = [], loading = true, saving = false, errorMessage = '', selId = null, draft = null;

  onMount(load);
  async function load() {
    const r = await apiCall('permissions/get-user-list');
    if (r?.errorMessage) errorMessage = r.errorMessage;
    users = r?.users ?? [];
    roles = r?.roles ?? [];
    loading = false;
  }
  function select(u) { selId = u.id; draft = JSON.parse(JSON.stringify(u)); errorMessage = ''; }
  function startNew() {
    selId = null;
    draft = { login: '', name: '', tenant: '', expires: '', status: 'active', roles: ['unassigned'] };
    errorMessage = '';
  }
  function toggleRole(id) {
    const has = (draft.roles ?? []).includes(id);
    draft = { ...draft, roles: has ? draft.roles.filter(x => x !== id) : [...(draft.roles ?? []), id] };
  }
  async function save() {
    saving = true; errorMessage = '';
    const r = await apiCall('permissions/save-user-detail', { user: draft });
    saving = false;
    if (r?.errorMessage) { errorMessage = r.errorMessage; return; }
    await load();
    const fresh = users.find(x => x.id === (r?.user?.id ?? selId));
    if (fresh) select(fresh);
  }
  async function remove() {
    if (!selId) return;
    if (!confirm(`确定删除成员 ${draft?.login}？`)) return;
    const r = await apiCall('permissions/delete-user', { userId: selId });
    if (r?.errorMessage) { errorMessage = r.errorMessage; return; }
    selId = null; draft = null;
    await load();
  }
</script>

<div class="aP" data-testid="AdminUsersPage">
  {#if loading}
    <div class="aP-empty">加载中…</div>
  {:else}
    {#if errorMessage}<div class="aP-err">{errorMessage}</div>{/if}
    <div class="aP-grid">
      <div class="aP-card">
        <div class="aP-h"><h2>成员 <span class="aP-sub">共 {users.length} 人</span></h2>
          <button class="aP-btn sm primary" on:click={startNew} data-testid="AdminUsersPage_new">＋ 新建成员</button></div>
        <table class="aP-tbl">
          <thead><tr><th>成员</th><th>登录名</th><th>角色</th><th>状态</th><th>有效期</th></tr></thead>
          <tbody>
            {#each users as u (u.id)}
              <tr class:sel={selId === u.id} on:click={() => select(u)} role="button" tabindex="0"
                  on:keydown={e => e.key === 'Enter' && select(u)} data-testid={`AdminUsersPage_user_${u.id}`}>
                <td>{u.name || u.login}</td>
                <td class="aP-mono">{u.login}</td>
                <td>{#each (u.roles ?? []) as rid (rid)}<span class="aP-pill">{roles.find(r => r.id === rid)?.name ?? rid}</span> {/each}</td>
                <td>{#if u.status === 'disabled'}<span class="aP-pill r">停用</span>{:else}<span class="aP-pill g">启用</span>{/if}</td>
                <td>{u.expires ? u.expires : '长期'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="aP-card">
        {#if draft}
          <div class="aP-h"><h2>{selId ? '编辑成员' : '新建成员'}</h2>
            {#if selId}<button class="aP-btn sm danger" on:click={remove}>删除</button>{/if}</div>
          <div class="aP-field"><div class="lb">登录名</div><input type="text" bind:value={draft.login} placeholder="zhangwei@yestar.com" data-testid="AdminUsersPage_login" /></div>
          <div class="aP-field"><div class="lb">显示名</div><input type="text" bind:value={draft.name} data-testid="AdminUsersPage_name" /></div>
          <div class="aP-field"><div class="lb">租户</div><input type="text" bind:value={draft.tenant} placeholder="院区 / 部门" /></div>
          <div class="aP-field"><div class="lb">有效期</div><input type="text" bind:value={draft.expires} placeholder="2026-12-31（空=长期）" /></div>
          <div class="aP-field"><div class="lb">状态</div>
            <select bind:value={draft.status}><option value="active">启用</option><option value="disabled">停用</option></select></div>
          <div class="aP-field"><div class="lb">角色</div>
            <div class="aP-checks">
              {#each roles as r (r.id)}
                <label><input type="checkbox" checked={(draft.roles ?? []).includes(r.id)} on:change={() => toggleRole(r.id)} /> {r.name}</label>
              {/each}
            </div>
          </div>
          <div style="margin-top:12px"><button class="aP-btn primary" on:click={save} disabled={saving} data-testid="AdminUsersPage_save">{saving ? '保存中…' : '保存'}</button></div>
          <div class="aP-sub" style="margin-top:8px">默认拒绝：新成员只有「待分配」角色时看不到任何库。</div>
        {:else}
          <div class="aP-empty">从左边选一个成员，或点「新建成员」</div>
        {/if}
      </div>
    </div>
  {/if}
</div>
