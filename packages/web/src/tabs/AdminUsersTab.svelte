<script lang="ts" context="module">
  export const matchingProps = [];
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { apiCall } from '../utility/api';
  import { _t } from '../translations';
  import LoadingInfo from '../elements/LoadingInfo.svelte';
  import FontIcon from '../icons/FontIcon.svelte';

  let isLoading = true;
  let errorMessage = '';
  let users = [];
  let roles = [];
  let edited: any = null;
  let isNew = false;

  const t = (key: string, defaultMessage: string) => _t(`admin.users.${key}`, { defaultMessage });

  // apiCall 不抛异常：失败时返回 { errorMessage }（并已经弹过 snackbar）
  function checkError(resp) {
    if (resp?.errorMessage) {
      errorMessage = resp.errorMessage;
      return true;
    }
    return false;
  }

  async function load() {
    isLoading = true;
    errorMessage = '';
    const resp = await apiCall('permissions/get-user-list');
    if (!checkError(resp)) {
      users = resp?.users ?? [];
      roles = resp?.roles ?? [];
    }
    isLoading = false;
  }

  function startNew() {
    isNew = true;
    edited = { login: '', name: '', roles: [], status: 'active', tenant: '', expires: '' };
  }

  function startEdit(user) {
    isNew = false;
    edited = { ...user, roles: [...(user.roles ?? [])] };
  }

  function toggleRole(roleId) {
    if (!edited) return;
    edited.roles = edited.roles.includes(roleId)
      ? edited.roles.filter(x => x !== roleId)
      : [...edited.roles, roleId];
  }

  async function save() {
    errorMessage = '';
    const resp = await apiCall('permissions/save-user-detail', { user: edited });
    if (checkError(resp)) return;
    edited = null;
    await load();
  }

  async function remove(user) {
    if (!confirm(t('confirmDelete', `Delete member ${user.login}?`))) return;
    errorMessage = '';
    const resp = await apiCall('permissions/delete-user', { userId: user.id });
    if (checkError(resp)) return;
    await load();
  }

  onMount(load);
</script>

<div class="page" data-testid="AdminUsersTab">
  <div class="head">
    <h2>{t('title', 'Members')}</h2>
    <div class="grow" />
    <button class="btn" on:click={startNew} data-testid="AdminUsersTab_newUserButton">
      <FontIcon icon="img add" /> {t('new', 'New member')}
    </button>
    <button class="btn" on:click={load} data-testid="AdminUsersTab_refreshButton">
      <FontIcon icon="img refresh" />
    </button>
  </div>

  {#if errorMessage}
    <div class="error" data-testid="AdminUsersTab_error">{errorMessage}</div>
  {/if}

  {#if isLoading}
    <LoadingInfo message={t('loading', 'Loading members')} />
  {:else}
    {#if edited}
      <div class="editor" data-testid="AdminUsersTab_editor">
        <h3>{isNew ? t('new', 'New member') : `${t('edit', 'Edit')} ${edited.login}`}</h3>
        <label>{t('login', 'Login')}
          <input
            type="text"
            bind:value={edited.login}
            readonly={!isNew}
            data-testid="AdminUsersTab_loginInput"
          />
        </label>
        <label>{t('name', 'Display name')}
          <input type="text" bind:value={edited.name} data-testid="AdminUsersTab_nameInput" />
        </label>
        <label>{t('tenant', 'Tenant / data scope')}
          <input type="text" bind:value={edited.tenant} data-testid="AdminUsersTab_tenantInput" />
        </label>
        <label>{t('status', 'Status')}
          <select bind:value={edited.status} data-testid="AdminUsersTab_statusSelect">
            <option value="active">{t('status.active', 'Active')}</option>
            <option value="disabled">{t('status.disabled', 'Disabled')}</option>
          </select>
        </label>
        <div class="roles">
          <div class="label">{t('roles', 'Roles')}</div>
          {#each roles as role}
            <label class="role">
              <input
                type="checkbox"
                checked={edited.roles.includes(role.id)}
                on:change={() => toggleRole(role.id)}
                data-testid={`AdminUsersTab_role_${role.id}`}
              />
              {role.name}
              {#if role.builtin}<span class="tag">{t('builtin', 'built-in')}</span>{/if}
            </label>
          {/each}
        </div>
        <div class="actions">
          <button class="btn primary" on:click={save} data-testid="AdminUsersTab_saveButton">
            {t('save', 'Save')}
          </button>
          <button class="btn" on:click={() => (edited = null)} data-testid="AdminUsersTab_cancelButton">
            {t('cancel', 'Cancel')}
          </button>
        </div>
      </div>
    {/if}

    <table class="tbl" data-testid="AdminUsersTab_table">
      <thead>
        <tr>
          <th>{t('login', 'Login')}</th>
          <th>{t('name', 'Display name')}</th>
          <th>{t('source', 'Source')}</th>
          <th>{t('roles', 'Roles')}</th>
          <th>{t('status', 'Status')}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {#each users as user (user.id)}
          <tr data-testid={`AdminUsersTab_row_${user.login}`}>
            <td class="mono">{user.login}</td>
            <td>{user.name}</td>
            <td>
              {user.source}
              {#if user.superAdminSource === 'doreamon'}<span class="tag auto">{t('autoSuperAdmin', 'auto superadmin')}</span>{/if}
              {#if user.superAdminSource === 'local'}<span class="tag">{t('localSuperAdmin', 'local superadmin')}</span>{/if}
            </td>
            <td>
              {#each user.roles as roleId}
                <span class="tag">{(roles.find(r => r.id === roleId) || {}).name ?? roleId}</span>
              {/each}
            </td>
            <td>{user.status === 'disabled' ? t('status.disabled', 'Disabled') : t('status.active', 'Active')}</td>
            <td class="row-actions">
              <button class="btn small" on:click={() => startEdit(user)} data-testid={`AdminUsersTab_edit_${user.login}`}>
                <FontIcon icon="img edit" />
              </button>
              <button class="btn small" on:click={() => remove(user)} data-testid={`AdminUsersTab_delete_${user.login}`}>
                <FontIcon icon="img delete" />
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if !users.length}
      <div class="empty">{t('empty', 'No members yet.')}</div>
    {/if}
  {/if}
</div>

<style>
  .page {
    padding: 10px;
    overflow: auto;
    flex: 1;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .grow {
    flex: 1;
  }
  .editor {
    border: 1px solid var(--theme-border);
    border-radius: 4px;
    padding: 10px;
    margin-bottom: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 520px;
  }
  .editor label {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .editor label input,
  .editor label select {
    flex: 1;
  }
  .roles .label {
    margin-bottom: 4px;
  }
  .role {
    display: block;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .tbl {
    width: 100%;
    border-collapse: collapse;
  }
  .tbl th,
  .tbl td {
    text-align: left;
    padding: 5px 8px;
    border-bottom: 1px solid var(--theme-border);
  }
  .row-actions {
    white-space: nowrap;
  }
  .tag {
    display: inline-block;
    padding: 0 6px;
    margin-right: 4px;
    border: 1px solid var(--theme-border);
    border-radius: 10px;
    font-size: 11px;
  }
  .tag.auto {
    border-color: var(--theme-primary);
  }
  .error {
    color: var(--theme-error-text-color, #c00);
    margin-bottom: 8px;
  }
  .empty {
    padding: 16px;
    opacity: 0.7;
  }
  .mono {
    font-family: monospace;
  }
</style>
