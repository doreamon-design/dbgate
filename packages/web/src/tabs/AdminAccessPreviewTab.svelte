<script lang="ts" context="module">
  export const matchingProps = [];
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { apiCall } from '../utility/api';
  import { _t } from '../translations';
  import LoadingInfo from '../elements/LoadingInfo.svelte';

  let isLoading = true;
  let errorMessage = '';
  let users = [];
  let connections = [];
  let selectedUserId = null;
  let access: any = null;

  // 「解析一个具体目标」用
  let target = { conid: '', database: '', table: '' };
  let resolved: any = null;

  const t = (key: string, defaultMessage: string) => _t(`admin.access.${key}`, { defaultMessage });

  function checkError(resp) {
    if (resp?.errorMessage) {
      errorMessage = resp.errorMessage;
      return true;
    }
    return false;
  }

  async function loadMembers() {
    isLoading = true;
    errorMessage = '';
    const [userResp, connResp] = await Promise.all([
      apiCall('permissions/get-user-list'),
      apiCall('permissions/get-connection-list'),
    ]);
    if (!checkError(userResp)) users = userResp?.users ?? [];
    if (!checkError(connResp)) connections = connResp?.connections ?? [];
    isLoading = false;
    if (!selectedUserId && users.length) await selectMember(users[0].id);
  }

  async function selectMember(userId) {
    errorMessage = '';
    resolved = null;
    const resp = await apiCall('permissions/get-user-access', { userId });
    if (checkError(resp)) return;
    selectedUserId = userId;
    access = resp;
    target = { conid: connections[0]?.conid ?? '', database: '', table: '' };
  }

  async function resolveTarget() {
    errorMessage = '';
    const resp = await apiCall('permissions/resolve-access', {
      userId: selectedUserId,
      conid: target.conid,
      database: target.database,
      table: target.table || undefined,
    });
    if (checkError(resp)) return;
    resolved = resp;
  }

  function levelClass(level) {
    if (!level || level === 'deny') return 'bad';
    if (level === 'view') return 'neutral';
    return 'good';
  }

  onMount(loadMembers);
</script>

<div class="page" data-testid="AdminAccessPreviewTab">
  <div class="head">
    <h2>{t('title', 'Access preview')}</h2>
    <span class="sub">{t('subtitle', 'What exactly can this member see?')}</span>
  </div>

  {#if errorMessage}
    <div class="error" data-testid="AdminAccessPreviewTab_error">{errorMessage}</div>
  {/if}

  {#if isLoading}
    <LoadingInfo message={t('loading', 'Loading members')} />
  {:else}
    <label class="inline">
      {t('member', 'Member')}
      <select
        bind:value={selectedUserId}
        on:change={() => selectMember(selectedUserId)}
        data-testid="AdminAccessPreviewTab_userSelect"
      >
        {#each users as user (user.id)}
          <option value={user.id}>{user.name} ({user.login})</option>
        {/each}
      </select>
    </label>

    {#if access}
      <div class="badges">
        {#if access.denied}<span class="badge bad" data-testid="AdminAccessPreviewTab_denied">{t('denied', 'Denied')}</span>{/if}
        {#if access.expired}<span class="badge warn">{t('expired', 'Expired')}</span>{/if}
        {#if access.connections.all}
          <span class="badge good">{t('allConnections', 'All connections')}</span>
        {:else}
          <span class="badge neutral">
            {access.connections.ids.length}
            {t('connections', 'connections')}
          </span>
        {/if}
        {#each access.roles as role (role.id)}
          <span class="badge neutral">{role.name}</span>
        {/each}
      </div>

      <h3>{t('databaseRules', 'Database rules')}</h3>
      {#if access.databaseRules.length}
        <table class="tbl" data-testid="AdminAccessPreviewTab_databaseRules">
          <thead>
            <tr>
              <th>{t('role', 'Role')}</th>
              <th>{t('connection', 'Connection')}</th>
              <th>{t('databasesList', 'Databases')}</th>
              <th>{t('level', 'Level')}</th>
            </tr>
          </thead>
          <tbody>
            {#each access.databaseRules as rule (rule.id)}
              <tr>
                <td>{rule.role_name}</td>
                <td class="mono">{rule.connection_id}</td>
                <td class="mono">{rule.database_names_list || rule.database_names_regex}</td>
                <td><span class="badge {levelClass(rule.database_role)}">{rule.database_role}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <div class="note">{t('noDatabaseRules', 'No database rules — this member cannot open any database.')}</div>
      {/if}

      {#if access.tableRules.length}
        <h3>{t('objectRules', 'Object overrides')}</h3>
        <table class="tbl" data-testid="AdminAccessPreviewTab_objectRules">
          <thead>
            <tr>
              <th>{t('role', 'Role')}</th>
              <th>{t('database', 'Database')}</th>
              <th>{t('scope', 'Scope')}</th>
              <th>{t('objectsList', 'Objects')}</th>
              <th>{t('objectRole', 'Object level')}</th>
            </tr>
          </thead>
          <tbody>
            {#each access.tableRules as rule (rule.id)}
              <tr>
                <td>{rule.role_name}</td>
                <td class="mono">{rule.database_names_list}</td>
                <td>{rule.table_scope}</td>
                <td class="mono">{rule.table_names_list}</td>
                <td><span class="badge neutral">{rule.table_role}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}

      <h3>{t('resolve', 'Resolve a concrete target')}</h3>
      <div class="resolve">
        <select bind:value={target.conid} data-testid="AdminAccessPreviewTab_conidSelect">
          {#each connections as conn (conn.conid)}
            <option value={conn.conid}>{conn.name}</option>
          {/each}
        </select>
        <input
          type="text"
          bind:value={target.database}
          placeholder={t('databasePlaceholder', 'database name')}
          data-testid="AdminAccessPreviewTab_databaseInput"
        />
        <input
          type="text"
          bind:value={target.table}
          placeholder={t('tablePlaceholder', 'table (optional)')}
          data-testid="AdminAccessPreviewTab_tableInput"
        />
        <button class="btn primary" on:click={resolveTarget} data-testid="AdminAccessPreviewTab_resolveButton">
          {t('resolveButton', 'Resolve')}
        </button>
      </div>

      {#if resolved}
        <div class="result" data-testid="AdminAccessPreviewTab_resolveResult">
          <div>
            {t('connection', 'Connection')}:
            <span class="badge {resolved.connectionAllowed ? 'good' : 'bad'}">
              {resolved.connectionAllowed ? t('allowed', 'allowed') : t('notAllowed', 'not allowed')}
            </span>
          </div>
          {#if resolved.databaseLevel !== null && resolved.databaseLevel !== undefined}
            <div>
              {t('database', 'Database')}:
              <span class="badge {levelClass(resolved.databaseLevel)}">{resolved.databaseLevel}</span>
              {#if resolved.viaAllDatabases}<span class="badge warn">{t('viaAllDatabases', 'via all-databases')}</span>{/if}
            </div>
          {/if}
          {#if resolved.tableRole}
            <div>
              {t('table', 'Table')}:
              <span class="badge neutral">{resolved.tableRole}</span>
              {#if resolved.viaAllTables}<span class="badge warn">{t('viaAllTables', 'via all-tables')}</span>{/if}
            </div>
          {/if}
        </div>
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
  .subtitle {
    opacity: 0.7;
  }
  .sub {
    opacity: 0.7;
    font-size: 12px;
  }
  .inline {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 0;
  }
  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 8px 0;
  }
  .badge {
    display: inline-block;
    padding: 0 6px;
    border: 1px solid var(--theme-border);
    border-radius: 10px;
    font-size: 11px;
  }
  .badge.good {
    border-color: var(--theme-icon-green, #2e7d32);
  }
  .badge.bad {
    border-color: var(--theme-icon-red, #c62828);
  }
  .badge.warn {
    border-color: var(--theme-icon-orange, #ef6c00);
  }
  .badge.neutral {
    opacity: 0.85;
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
  .mono {
    font-family: monospace;
  }
  .note {
    opacity: 0.7;
    font-size: 12px;
  }
  .resolve {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .result {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .error {
    color: var(--theme-error-text-color, #c00);
    margin-bottom: 8px;
  }
</style>
