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
  let summary: any = null;
  let users = [];
  let importResult: any = null;

  const t = (key: string, defaultMessage: string) => _t(`admin.auth.${key}`, { defaultMessage });

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
    const [summaryResp, userResp] = await Promise.all([
      apiCall('permissions/get-summary'),
      apiCall('permissions/get-user-list'),
    ]);
    if (!checkError(summaryResp)) summary = summaryResp;
    if (!checkError(userResp)) users = userResp?.users ?? [];
    isLoading = false;
  }

  async function importEnvUsers() {
    errorMessage = '';
    const resp = await apiCall('permissions/import-env-users');
    if (checkError(resp)) return;
    importResult = resp;
    await load();
  }

  $: sourceCounts = users.reduce((acc, u) => {
    const key = u.source || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  onMount(load);
</script>

<div class="page" data-testid="AdminAuthTab">
  <div class="head">
    <h2>{t('title', 'Login & member sources')}</h2>
    <span class="sub">{t('subtitle', 'Where members come from, and how authorization is derived')}</span>
  </div>

  {#if errorMessage}
    <div class="error" data-testid="AdminAuthTab_error">{errorMessage}</div>
  {/if}

  {#if isLoading}
    <LoadingInfo message={t('loading', 'Loading')} />
  {:else}
    <div class="card">
      <h3>
        {t('connectTitle', 'Doreamon login (go-zoox/connect gateway)')}
        {#if summary?.connectAuth?.enabled}
          <span class="badge good" data-testid="AdminAuthTab_connectEnabled">{t('enabled', 'enabled')}</span>
        {:else}
          <span class="badge neutral" data-testid="AdminAuthTab_connectDisabled">{t('disabled', 'not enabled')}</span>
        {/if}
      </h3>
      <div class="note">
        {t(
          'connectNote',
          'Members sign in through the gateway; it injects X-Connect-Token (JWT, HS256). This server only verifies it and maps the identity to a local member — no member password is stored here.'
        )}
      </div>
      <table class="kv">
        <tbody>
          <tr><td>{t('envConnectAuth', 'CONNECT_AUTH')}</td><td class="mono">{summary?.connectAuth?.enabled ? '1' : '—'}</td></tr>
          <tr>
            <td>{t('envSecret', 'SESSION_KEY / SECRET_KEY')}</td>
            <td class="mono">{summary?.connectAuth?.hasSecret ? t('set', 'set') : t('missing', 'MISSING — token verification is refused')}</td>
          </tr>
          <tr><td>{t('envLogout', 'CONNECT_LOGOUT_URL')}</td><td class="mono">{summary?.connectAuth?.logoutUrl || '—'}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3>{t('superAdminTitle', 'SUPER_ADMIN → superadmin')}</h3>
      <div class="note">
        {t(
          'superAdminNote',
          'If the token permissions claim contains SUPER_ADMIN, this member is made a superadmin on every login (idempotent, audited). Losing it revokes only the grant that came from Doreamon; a locally granted fallback admin is never removed. An empty permissions claim is treated as "unknown": the request is denied, but roles are left untouched.'
        )}
      </div>
      <div class="badge neutral mono">{summary?.superAdminPermission || 'SUPER_ADMIN'}</div>
    </div>

    <div class="card">
      <h3>
        {t('sourcesTitle', 'Member sources')}
        <button class="btn small" on:click={importEnvUsers} data-testid="AdminAuthTab_importEnvButton">
          <FontIcon icon="icon add" /> {t('importEnv', 'Import env logins')}
        </button>
      </h3>
      <div class="badges">
        {#each Object.entries(sourceCounts) as [source, count] (source)}
          <span class="badge neutral">{source}: {count}</span>
        {/each}
      </div>
      {#if importResult}
        <div class="note" data-testid="AdminAuthTab_importResult">
          {t('detected', 'Detected')}: {importResult.detected?.length ?? 0} ·
          {t('imported', 'imported')}: {importResult.imported?.length ?? 0} ·
          {t('skipped', 'already members')}: {importResult.skipped?.length ?? 0}
          {#if importResult.imported?.length}
            <div class="mono">{importResult.imported.join(', ')}</div>
          {/if}
        </div>
      {/if}
      <div class="note">
        {t(
          'importEnvNote',
          'Imported logins keep the pre-upgrade visibility (they get the legacy role). Roles you changed in the UI are never overwritten.'
        )}
      </div>
    </div>

    <div class="card">
      <h3>{t('storeTitle', 'Permission store')}</h3>
      <table class="kv">
        <tbody>
          <tr><td>{t('file', 'File')}</td><td class="mono">{summary?.path || '—'}</td></tr>
          <tr><td>{t('version', 'Schema version')}</td><td class="mono">{summary?.version ?? '—'}</td></tr>
          <tr><td>{t('counts', 'Members / roles / grants')}</td>
            <td class="mono">{summary?.users ?? 0} / {summary?.roles ?? 0} / {(summary?.connections ?? 0) + (summary?.databases ?? 0) + (summary?.tables ?? 0)}</td>
          </tr>
        </tbody>
      </table>
    </div>
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
    margin-bottom: 8px;
  }
  .sub {
    opacity: 0.7;
    font-size: 12px;
  }
  .card {
    border: var(--theme-table-border);
    border-radius: 4px;
    padding: 10px;
    margin-bottom: 10px;
    max-width: 760px;
  }
  .card h3 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 6px;
  }
  .kv {
    width: 100%;
    border-collapse: collapse;
    margin-top: 6px;
  }
  .kv td {
    padding: 3px 6px 3px 0;
    vertical-align: top;
    border-bottom: var(--theme-table-border);
  }
  .kv td:first-child {
    opacity: 0.75;
    width: 240px;
  }
  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 6px 0;
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
  .mono {
    font-family: monospace;
  }
  .note {
    opacity: 0.75;
    font-size: 12px;
    line-height: 1.7;
  }
  .error {
    color: var(--theme-error-text-color, #c00);
    margin-bottom: 8px;
  }
</style>
