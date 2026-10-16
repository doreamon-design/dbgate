<script lang="ts" context="module">
  import FormFieldTemplateLarge from '../forms/FormFieldTemplateLarge.svelte';
  export const matchingProps = [];
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { apiCall } from '../utility/api';
  import { _t } from '../translations';
  import LoadingInfo from '../elements/LoadingInfo.svelte';

  let isLoading = true;
  let errorMessage = '';
  let connections = [];
  let databases = [];
  let databaseRoles = [];
  let tableRoles = [];
  let members = [];

  let conid = '';
  let database = '';
  let matrix: any = null;
  let tables = [];
  let drillRoleId = null;
  let drillRules = {};

  const t = (key: string, defaultMessage: string) => _t(`admin.matrix.${key}`, { defaultMessage });

  function checkError(resp) {
    if (resp?.errorMessage) {
      errorMessage = resp.errorMessage;
      return true;
    }
    return false;
  }

  // 文件型引擎（sqlite/duckdb）的 list-databases 必然为空，要用连接上的 defaultDatabase
  async function loadDatabases() {
    databases = [];
    database = '';
    const conn = connections.find(c => c.conid === conid);
    if (!conn) return;

    const resp = await apiCall('server-connections/list-databases', { conid });
    if (!checkError(resp)) databases = (resp ?? []).map(x => x.name);
    if (!databases.length && conn.defaultDatabase) databases = [conn.defaultDatabase];
    database = databases[0] ?? '';
  }

  async function loadMatrix() {
    if (!conid || !database) {
      matrix = null;
      tables = [];
      return;
    }
    const resp = await apiCall('permissions/get-access-matrix', {
      conid,
      database,
      userIds: members.map(m => m.id),
    });
    if (!checkError(resp)) matrix = resp;
  }

  async function loadTables() {
    tables = [];
    drillRules = {};
    if (!conid || !database) return;
    const resp = await apiCall('database-connections/structure', { conid, database });
    if (!checkError(resp)) tables = (resp?.tables ?? []).map(x => x.pureName);
    await loadDrillRules();
  }

  async function loadDrillRules() {
    drillRules = {};
    if (!drillRoleId) return;
    const resp = await apiCall('permissions/get-role-detail', { roleId: drillRoleId });
    if (checkError(resp)) return;
    for (const row of resp?.tables ?? []) {
      if (row.database_names_list && row.database_names_list !== database) continue;
      for (const name of String(row.table_names_list || '')
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)) {
        drillRules[name] = { ruleId: row.id, levelId: row.table_permission_role_id };
      }
    }
  }

  async function onConnectionChange() {
    errorMessage = '';
    await loadDatabases();
    await loadMatrix();
    await loadTables();
  }

  async function onDatabaseChange() {
    errorMessage = '';
    await loadMatrix();
    await loadTables();
  }

  // 角色格：'' = 无规则（删掉该格上的显式规则）
  async function setRoleCell(role, value) {
    errorMessage = '';
    const existing = matrix?.roles.find(r => r.id === role.id);
    let resp;
    if (!value) {
      if (!existing?.ruleId) return;
      resp = await apiCall('permissions/delete-role-database', { rowId: existing.ruleId });
    } else {
      resp = await apiCall('permissions/save-role-database', {
        id: existing?.ruleId ?? undefined,
        role_id: role.id,
        connection_id: conid,
        database_names_list: database,
        database_permission_role_id: Number(value),
      });
    }
    if (checkError(resp)) return;
    await loadMatrix();
  }

  async function setTableRole(tableName, value) {
    errorMessage = '';
    if (!drillRoleId) return;
    const existing = drillRules[tableName];
    let resp;
    if (!value) {
      if (!existing?.ruleId) return;
      resp = await apiCall('permissions/delete-role-table', { rowId: existing.ruleId });
    } else {
      resp = await apiCall('permissions/save-role-table', {
        id: existing?.ruleId ?? undefined,
        role_id: drillRoleId,
        connection_id: conid,
        database_names_list: database,
        table_names_list: tableName,
        table_permission_role_id: Number(value),
        table_permission_scope_id: -2,
      });
    }
    if (checkError(resp)) return;
    await loadDrillRules();
  }

  function levelBadgeClass(level) {
    if (!level || level === 'deny') return 'bad';
    if (level === 'view') return 'neutral';
    if (level === 'read_content') return 'ready';
    return 'good';
  }

  onMount(async () => {
    const [connResp, optResp, userResp] = await Promise.all([
      apiCall('permissions/get-connection-list'),
      apiCall('permissions/get-options'),
      apiCall('permissions/get-user-list'),
    ]);
    if (!checkError(connResp)) connections = connResp?.connections ?? [];
    if (!checkError(optResp)) {
      databaseRoles = optResp?.databaseRoles ?? [];
      tableRoles = optResp?.tableRoles ?? [];
    }
    if (!checkError(userResp)) members = userResp?.users ?? [];
    conid = connections[0]?.conid ?? '';
    isLoading = false;
    await onConnectionChange();
  });
</script>

<div class="page" data-testid="AdminMatrixTab">
  <div class="head">
    <h2>{t('title', 'Access matrix')}</h2>
    <span class="sub">{t('subtitle', 'One row per database, one column per role (editable) and per member (read-only)')}</span>
  </div>

  {#if errorMessage}
    <div class="error" data-testid="AdminMatrixTab_error">{errorMessage}</div>
  {/if}

  {#if isLoading}
    <LoadingInfo message={t('loading', 'Loading')} />
  {:else}
    <div class="toolbar">
      <FormFieldTemplateLarge label={t('connection', 'Connection')}>
        <select bind:value={conid} on:change={onConnectionChange} data-testid="AdminMatrixTab_connectionSelect">
          {#each connections as conn (conn.conid)}
            <option value={conn.conid}>{conn.name}</option>
          {/each}
        </select>
        </FormFieldTemplateLarge>
      <FormFieldTemplateLarge label={t('database', 'Database')}>
        {#if databases.length > 1}
          <select bind:value={database} on:change={onDatabaseChange} data-testid="AdminMatrixTab_databaseSelect">
            {#each databases as db (db)}
              <option value={db}>{db}</option>
            {/each}
          </select>
        {:else}
          <span class="mono" data-testid="AdminMatrixTab_databaseName">{database || '—'}</span>
        {/if}
        </FormFieldTemplateLarge>
    </div>

    {#if !connections.length}
      <div class="note">{t('noConnections', 'No connections configured yet.')}</div>
    {:else if matrix}
      <div class="scroll">
        <table class="matrix" data-testid="AdminMatrixTab_matrix">
          <thead>
            <tr>
              <th class="sticky">{t('database', 'Database')}</th>
              {#each matrix.roles as role (role.id)}
                <th title={role.name} data-testid={`AdminMatrixTab_roleHeader_${role.id}`}>
                  {role.name}
                  <span class="sub">{role.memberCount}</span>
                </th>
              {/each}
              {#each matrix.users as user (user.userId)}
                <th class="user-col" data-testid={`AdminMatrixTab_userHeader_${user.login}`}>{user.name || user.login}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="sticky mono">{database}</td>
              {#each matrix.roles as role (role.id)}
                <td>
                  <select
                    value={role.levelId ?? ''}
                    disabled={!!role.builtin}
                    on:change={event => setRoleCell(role, event.currentTarget.value)}
                    data-testid={`AdminMatrixTab_cell_${role.id}`}
                  >
                    <option value="">{t('noRule', '— inherit / no rule')}</option>
                    {#each databaseRoles as level (level.id)}
                      <option value={level.id}>{level.name}</option>
                    {/each}
                  </select>
                </td>
              {/each}
              {#each matrix.users as user (user.userId)}
                <td class="user-col">
                  {#if user.missing}
                    <span class="badge bad">?</span>
                  {:else}
                    <span class="badge {levelBadgeClass(user.level)}" data-testid={`AdminMatrixTab_userCell_${user.login}`}>
                      {user.level ?? '—'}
                    </span>
                    {#if user.denied}<span class="badge warn">{t('denied', 'denied')}</span>{/if}
                    {#if !user.connectionAllowed}<span class="badge warn">{t('noConnection', 'no connection')}</span>{/if}
                  {/if}
                </td>
              {/each}
            </tr>
          </tbody>
        </table>
      </div>

      <div class="note" style="margin-top:8px">
        {t(
          'legend',
          'Role columns write a database rule for that role (deny by default: a database with no rule is invisible). Member columns are computed from the roles and cannot be edited — change the role instead.'
        )}
      </div>

      <h3 style="margin-top:14px">{t('objectTitle', 'Object overrides')}</h3>
      <div class="toolbar">
        <FormFieldTemplateLarge label={t('role', 'Role')}>
          <select bind:value={drillRoleId} on:change={loadDrillRules} data-testid="AdminMatrixTab_drillRoleSelect">
            <option value={null}>{t('pickRole', '— pick a role —')}</option>
            {#each matrix.roles as role (role.id)}
              <option value={role.id}>{role.name}</option>
            {/each}
          </select>
          </FormFieldTemplateLarge>
      </div>
      {#if !drillRoleId}
        <div class="note">{t('pickRoleNote', 'Pick a role to give object-level exceptions inside this database.')}</div>
      {:else if !tables.length}
        <div class="note">{t('noTables', 'No tables found (the connection may still be analysing — reopen this tab).')}</div>
      {:else}
        <table class="tbl" data-testid="AdminMatrixTab_objectTable">
          <thead>
            <tr>
              <th>{t('table', 'Table')}</th>
              <th>{t('objectRole', 'Object level')}</th>
            </tr>
          </thead>
          <tbody>
            {#each tables as tableName (tableName)}
              <tr>
                <td class="mono">{tableName}</td>
                <td>
                  <select
                    value={drillRules[tableName]?.levelId ?? ''}
                    on:change={event => setTableRole(tableName, event.currentTarget.value)}
                    data-testid={`AdminMatrixTab_objectCell_${tableName}`}
                  >
                    <option value="">{t('inherit', '— inherit database level')}</option>
                    {#each tableRoles as level (level.id)}
                      <option value={level.id}>{level.name}</option>
                    {/each}
                  </select>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
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
    align-items: baseline;
    gap: 8px;
  }
  .toolbar {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    align-items: center;
    margin: 8px 0;
  }
  .inline {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .scroll {
    overflow: auto;
    max-height: 60vh;
    border: var(--theme-table-border);
    border-radius: 4px;
  }
  .matrix {
    border-collapse: separate;
    border-spacing: 0;
  }
  .matrix th,
  .matrix td {
    border-right: var(--theme-table-border);
    border-bottom: var(--theme-table-border);
    padding: 4px 8px;
    text-align: left;
    white-space: nowrap;
  }
  .matrix th {
    position: sticky;
    top: 0;
    background: var(--theme-bg, #fff);
    z-index: 2;
  }
  .matrix .sticky {
    position: sticky;
    left: 0;
    background: var(--theme-bg, #fff);
    z-index: 1;
  }
  .matrix th.sticky {
    z-index: 3;
  }
  .user-col {
    opacity: 0.9;
  }
  .badge {
    display: inline-block;
    padding: 0 6px;
    border: var(--theme-table-border);
    border-radius: 10px;
    font-size: 11px;
  }
  .badge.good {
    border-color: var(--theme-icon-green, #2e7d32);
  }
  .badge.ready {
    border-color: var(--theme-icon-blue, #1565c0);
  }
  .badge.bad {
    border-color: var(--theme-icon-red, #c62828);
  }
  .badge.warn {
    border-color: var(--theme-icon-orange, #ef6c00);
  }
  .tbl {
    width: 100%;
    border-collapse: collapse;
    max-width: 620px;
  }
  .tbl th,
  .tbl td {
    text-align: left;
    padding: 4px 6px;
    border-bottom: var(--theme-table-border);
  }
  .mono {
    font-family: monospace;
  }
  .sub {
    opacity: 0.6;
    font-size: 11px;
  }
  .note {
    opacity: 0.75;
    font-size: 12px;
  }
  .error {
    color: var(--theme-error-text-color, #c00);
    margin-bottom: 8px;
  }
</style>
