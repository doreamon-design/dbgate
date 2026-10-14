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
  let roles = [];
  let users = [];
  let connections = [];
  let databaseRoles = [];
  let selectedRoleId = null;
  let draft: any = null;
  let grants = { all: false, ids: [] };
  let dbRules = [];

  const t = (key: string, defaultMessage: string) => _t(`admin.roles.${key}`, { defaultMessage });

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
    const [listResp, connResp, optResp] = await Promise.all([
      apiCall('permissions/get-role-list'),
      apiCall('permissions/get-connection-list'),
      apiCall('permissions/get-options'),
    ]);
    if (!checkError(listResp)) {
      roles = listResp?.roles ?? [];
      users = listResp?.users ?? [];
    }
    if (!checkError(connResp)) connections = connResp?.connections ?? [];
    if (!checkError(optResp)) databaseRoles = optResp?.databaseRoles ?? [];
    isLoading = false;
    if (!selectedRoleId && roles.length) await selectRole(roles[0].id);
  }

  async function selectRole(roleId) {
    const resp = await apiCall('permissions/get-role-detail', { roleId });
    if (checkError(resp)) return;
    selectedRoleId = roleId;
    draft = {
      ...resp.role,
      permissionsText: (resp.role.permissions ?? []).join('\n'),
    };
    grants = { all: !!resp.role.connections?.all, ids: (resp.connections ?? []).map(x => x.connection_id) };
    dbRules = (resp.databases ?? []).map(x => ({ ...x }));
  }

  function toggleConnection(conid) {
    grants.ids = grants.ids.includes(conid) ? grants.ids.filter(x => x !== conid) : [...grants.ids, conid];
  }

  function addDbRule() {
    dbRules = [
      ...dbRules,
      { connection_id: connections[0]?.conid ?? '', database_names_list: '', database_permission_role_id: -2 },
    ];
  }

  function removeDbRule(index) {
    dbRules = dbRules.filter((_, i) => i !== index);
  }

  async function save() {
    errorMessage = '';
    const resp = await apiCall('permissions/save-role-detail', {
      role: {
        id: draft.id,
        name: draft.name,
        description: draft.description,
        permissions: draft.permissionsText
          .split('\n')
          .map(x => x.trim())
          .filter(Boolean),
      },
      connections: { all: grants.all, ids: grants.ids },
      databases: dbRules,
    });
    if (checkError(resp)) return;
    await load();
    await selectRole(resp?.role?.id ?? selectedRoleId);
  }

  function isBuiltin(role) {
    return !!roles.find(x => x.id === role?.id)?.builtin;
  }

  onMount(load);
</script>

<div class="page" data-testid="AdminRolesTab">
  {#if errorMessage}
    <div class="error" data-testid="AdminRolesTab_error">{errorMessage}</div>
  {/if}

  {#if isLoading}
    <LoadingInfo message={t('loading', 'Loading roles')} />
  {:else}
    <div class="layout">
      <div class="list">
        <div class="head">
          <strong>{t('title', 'Roles')}</strong>
          <span class="grow" />
          <button class="btn small" on:click={load} data-testid="AdminRolesTab_refreshButton">
            <FontIcon icon="icon refresh" />
          </button>
        </div>
        {#each roles as role (role.id)}
          <div
            class="item"
            class:selected={role.id === selectedRoleId}
            on:click={() => selectRole(role.id)}
            data-testid={`AdminRolesTab_role_${role.id}`}
          >
            {role.name}
            {#if role.builtin}<span class="tag">{t('builtin', 'built-in')}</span>{/if}
            <span class="count">{users.filter(u => (u.roles ?? []).includes(role.id)).length}</span>
          </div>
        {/each}
      </div>

      <div class="detail">
        {#if draft}
          <h2 data-testid="AdminRolesTab_detailTitle">{draft.name}</h2>
          <label>{t('name', 'Name')}
            <input type="text" bind:value={draft.name} data-testid="AdminRolesTab_nameInput" />
          </label>
          <label>{t('description', 'Description')}
            <input type="text" bind:value={draft.description} data-testid="AdminRolesTab_descriptionInput" />
          </label>
          <label class="block">{t('permissions', 'Permission strings (one per line)')}
            <textarea rows="4" bind:value={draft.permissionsText} data-testid="AdminRolesTab_permissionsInput" />
          </label>
          {#if isBuiltin(draft)}
            <div class="note">{t('builtinNote', 'Built-in role: permissions are fixed by the code.')}</div>
          {/if}

          <h3>{t('connections', 'Connections')}</h3>
          <label class="inline">
            <input type="checkbox" bind:checked={grants.all} data-testid="AdminRolesTab_allConnections" />
            {t('allConnections', 'All connections (including future ones)')}
          </label>
          {#if !grants.all}
            <div class="connections">
              {#each connections as conn (conn.conid)}
                <label class="inline">
                  <input
                    type="checkbox"
                    checked={grants.ids.includes(conn.conid)}
                    on:change={() => toggleConnection(conn.conid)}
                    data-testid={`AdminRolesTab_conn_${conn.conid}`}
                  />
                  {conn.name} <span class="sub">{conn.engine}</span>
                </label>
              {/each}
            </div>
          {/if}

          <h3>
            {t('databases', 'Databases')}
            <button class="btn small" on:click={addDbRule} data-testid="AdminRolesTab_addDatabaseRule">
              <FontIcon icon="icon add" />
            </button>
          </h3>
          <table class="tbl" data-testid="AdminRolesTab_databaseRules">
            <thead>
              <tr>
                <th>{t('connection', 'Connection')}</th>
                <th>{t('databasesList', 'Databases (comma separated)')}</th>
                <th>{t('level', 'Level')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {#each dbRules as rule, index}
                <tr data-testid={`AdminRolesTab_dbRule_${index}`}>
                  <td>
                    <select bind:value={rule.connection_id}>
                      {#each connections as conn (conn.conid)}
                        <option value={conn.conid}>{conn.name}</option>
                      {/each}
                    </select>
                  </td>
                  <td>
                    <input
                      type="text"
                      bind:value={rule.database_names_list}
                      placeholder="order_db, user_db"
                      data-testid={`AdminRolesTab_dbNames_${index}`}
                    />
                  </td>
                  <td>
                    <select bind:value={rule.database_permission_role_id} data-testid={`AdminRolesTab_dbLevel_${index}`}>
                      {#each databaseRoles as level (level.id)}
                        <option value={level.id}>{level.name}</option>
                      {/each}
                    </select>
                  </td>
                  <td>
                    <button class="btn small" on:click={() => removeDbRule(index)}>
                      <FontIcon icon="icon delete" />
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if !dbRules.length}
            <div class="note">
              {t('noRules', 'No database rules: this role can see the granted connections but none of their databases.')}
            </div>
          {/if}

          <div class="actions">
            <button class="btn primary" on:click={save} data-testid="AdminRolesTab_saveButton">
              {t('save', 'Save')}
            </button>
          </div>
        {:else}
          <div class="note">{t('select', 'Select a role on the left.')}</div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .page {
    padding: 10px;
    overflow: auto;
    flex: 1;
  }
  .layout {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  .list {
    min-width: 200px;
    border: 1px solid var(--theme-border);
    border-radius: 4px;
  }
  .list .head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--theme-border);
  }
  .grow {
    flex: 1;
  }
  .item {
    padding: 5px 8px;
    cursor: pointer;
  }
  .item.selected {
    background: var(--theme-bg-selected, rgba(128, 128, 128, 0.2));
  }
  .count {
    float: right;
    opacity: 0.6;
  }
  .detail {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .detail label {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .detail label input,
  .detail label textarea {
    flex: 1;
  }
  .detail label.block {
    align-items: flex-start;
  }
  .connections {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 4px;
  }
  .inline {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .tbl {
    width: 100%;
    border-collapse: collapse;
  }
  .tbl th,
  .tbl td {
    text-align: left;
    padding: 4px 6px;
    border-bottom: 1px solid var(--theme-border);
  }
  .tag {
    display: inline-block;
    padding: 0 6px;
    border: 1px solid var(--theme-border);
    border-radius: 10px;
    font-size: 11px;
  }
  .note {
    opacity: 0.7;
    font-size: 12px;
  }
  .sub {
    opacity: 0.6;
  }
  .actions {
    margin-top: 8px;
  }
  .error {
    color: var(--theme-error-text-color, #c00);
    margin-bottom: 8px;
  }
</style>
