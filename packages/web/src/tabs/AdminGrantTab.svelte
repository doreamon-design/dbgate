<script lang="ts">
  import { onMount } from 'svelte';
  import { apiCall } from '../utility/api';
  import { _t } from '../translations';
  import LoadingInfo from '../elements/LoadingInfo.svelte';
  import FontIcon from '../icons/FontIcon.svelte';
  // 用仓库自带的表单组件（不再自造 div+label+CSS）
  import FormFieldTemplateLarge from '../forms/FormFieldTemplateLarge.svelte';
  import CheckboxField from '../forms/CheckboxField.svelte';
  import TextField from '../forms/TextField.svelte';

  export const matchingProps = [];

  let isLoading = true;
  let errorMessage = '';
  let members = [];
  let connections = [];
  let databases = {}; // conid -> [{name}]
  let levelOptions = [];
  let operationGroups = [];

  let selectedUserId = null;
  let grants = { scope: [], operations: [], limits: { maxRows: 0, timeoutSeconds: 0, allowedHours: '', allowedIps: '' } };
  let saving = false;
  let lastSaved = '';

  const t = (key, def) => _t(key, { defaultMessage: def });

  function checkError(resp) {
    if (resp?.errorMessage) {
      errorMessage = resp.errorMessage;
      return true;
    }
    return false;
  }

  onMount(async () => {
    const [membersResp, connResp, optResp] = await Promise.all([
      apiCall('permissions/get-user-list'),
      apiCall('permissions/get-connection-list'),
      apiCall('permissions/get-options'),
    ]);
    if (!checkError(membersResp)) members = membersResp?.users ?? membersResp ?? [];
    if (!checkError(connResp)) connections = connResp?.connections ?? [];
    if (!checkError(optResp)) operationGroups = optResp?.operationPermissions ?? [];
    isLoading = false;

    // 连接下的库（多库引擎），失败就退到 defaultDatabase
    for (const conn of connections) {
      // 路由在 serverConnections 控制器下（写成 database-connections/... 会 404）
      const resp = await apiCall('server-connections/list-databases', { conid: conn.conid });
      const list = (resp?.databases ?? resp ?? []).map(x => (typeof x === 'string' ? { name: x } : x)).filter(x => x?.name);
      databases = { ...databases, [conn.conid]: list.length ? list : conn.defaultDatabase ? [{ name: conn.defaultDatabase }] : [] };
    }

    if (members.length) await selectMember(members[0].id);
  });

  async function selectMember(userId) {
    selectedUserId = userId;
    errorMessage = '';
    const resp = await apiCall('permissions/get-member-grants', { userId });
    if (checkError(resp)) return;
    grants = resp.grants ?? grants;
    levelOptions = resp.databaseLevels ?? [];
  }

  const levelOf = (conid, database) =>
    (grants.scope ?? []).find(x => x.conid === conid && x.database === database)?.level ?? 'none';

  async function setLevel(conid, database, level) {
    const current = levelOf(conid, database);
    saving = true;
    errorMessage = '';
    const resp =
      current === level && level !== 'none'
        ? await apiCall('permissions/delete-member-scope', { userId: selectedUserId, conid, database })
        : await apiCall('permissions/save-member-scope', { userId: selectedUserId, conid, database, level });
    if (!checkError(resp)) {
      grants = resp.grants ?? grants;
      lastSaved = `已保存 ${database} → ${level}`;
    }
    saving = false;
  }

  function isOperationOn(permission) {
    return (grants.operations ?? []).includes(permission);
  }

  async function toggleOperation(permission) {
    const next = isOperationOn(permission)
      ? grants.operations.filter(x => x !== permission)
      : [...(grants.operations ?? []), permission];
    saving = true;
    errorMessage = '';
    const resp = await apiCall('permissions/save-member-operations', { userId: selectedUserId, operations: next });
    if (!checkError(resp)) {
      grants = resp.grants ?? grants;
      const removed = resp.removed ?? [];
      lastSaved = removed.length
        ? `已保存；系统自动关闭了：${removed.map(x => x.op).join('、')}`
        : '已保存操作权限';
    }
    saving = false;
  }

  async function saveLimits() {
    saving = true;
    errorMessage = '';
    const resp = await apiCall('permissions/save-member-limits', {
      userId: selectedUserId,
      limits: grants.limits,
    });
    if (!checkError(resp)) {
      grants = resp.grants ?? grants;
      lastSaved = '已保存使用限制';
    }
    saving = false;
  }

  // 顶部"人话总结"与风险提示 —— 管理员不用自己拼
  $: visibleDbs = (grants.scope ?? []).filter(x => x.level && x.level !== 'deny');
  $: deniedDbs = (grants.scope ?? []).filter(x => x.level === 'deny');
  $: opCount = (grants.operations ?? []).length;
  $: hasRowFilter = (grants.rowFilters ?? []).length > 0;
  $: hasMask = (grants.columnMasks ?? []).length > 0;

  function opCheck(permission) {
    return (grants.operations ?? []).includes(permission);
  }
</script>

<div class="page" data-testid="AdminGrantTab">
  {#if isLoading}
    <LoadingInfo message={t('loading', '加载中')} />
  {:else}
    {#if errorMessage}
      <div class="error" data-testid="AdminGrantTab_error">{errorMessage}</div>
    {/if}

    <!-- 人话总结 -->
    <div class="summary" data-testid="AdminGrantTab_summary">
      <b>{members.find(m => m.id === selectedUserId)?.name ?? ''}</b>
      <span class="muted">{members.find(m => m.id === selectedUserId)?.login ?? ''}</span>
      <span class="tag info">可见 {visibleDbs.length} 个库</span>
      <span class="tag info">可操作 {opCount} 项</span>
      {#if deniedDbs.length}<span class="tag warn">明确拒绝 {deniedDbs.length} 个库</span>{/if}
      {#if saving}<span class="muted">保存中…</span>{/if}
      {#if lastSaved}<span class="muted" data-testid="AdminGrantTab_saved">{lastSaved}</span>{/if}
    </div>

    {#if hasRowFilter && opCheck('run-script')}
      <div class="notice warn">该成员配有行级过滤，「执行任意脚本」能绕过它 —— 保存时会被强制关闭。</div>
    {/if}
    {#if hasMask && opCheck('dbops/sql-dump/export')}
      <div class="notice warn">该成员配有列脱敏，导出通道尚未套用脱敏 —— 保存时会被强制关闭。</div>
    {/if}

    <div class="grid">
      <!-- ① 选成员 -->
      <div class="card">
        <h3>① 选成员</h3>
        <ul class="members" data-testid="AdminGrantTab_memberList">
          {#each members as m (m.id)}
            <li class:on={m.id === selectedUserId} data-testid={`AdminGrantTab_member_${m.id}`}>
              <button class="memberbtn" on:click={() => selectMember(m.id)}>
                <span class="who">
                  <b>{m.name || m.login}</b>
                  <span>{m.login}</span>
                </span>
                {#if m.status === 'disabled'}<span class="tag bad">停用</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      </div>

      <!-- ② 能看哪些库 -->
      <div class="card">
        <h3>② 能看哪些库 <span class="hint">不勾 = 不可见</span></h3>
        {#each connections as conn (conn.conid)}
          <div class="conn">
            <div class="connhead">
              <FontIcon icon="icon database" padRight />
              <b>{conn.name}</b><span class="muted"> {String(conn.engine || '').split('@')[0]}</span>
            </div>
            {#each databases[conn.conid] ?? [] as db (db.name)}
              <div class="dbrow" data-testid={`AdminGrantTab_db_${conn.conid}_${db.name}`}>
                <CheckboxField
                  checked={levelOf(conn.conid, db.name) !== 'none'}
                  on:change={e => setLevel(conn.conid, db.name, e.target.checked ? 'read_content' : 'none')}
                />
                <span class="dbname">{db.name}</span>
                <span class="levels">
                  {#each levelOptions as opt (opt.level)}
                    <button
                      class:on={levelOf(conn.conid, db.name) === opt.level}
                      title={opt.hint}
                      on:click={() => setLevel(conn.conid, db.name, opt.level)}
                      data-testid={`AdminGrantTab_level_${conn.conid}_${db.name}_${opt.level}`}
                    >{opt.label}</button>
                  {/each}
                </span>
              </div>
            {/each}
            {#if !(databases[conn.conid] ?? []).length}
              <div class="muted">（没取到库清单，可能是连接未就绪）</div>
            {/if}
          </div>
        {/each}
      </div>

      <!-- ③ 能做什么 -->
      <div class="card">
        <h3>③ 能做什么 <span class="hint">关掉 = 显式拒绝</span></h3>
        {#each operationGroups as op (op.key)}
          <div class="oprow" data-testid={`AdminGrantTab_oprow_${op.key}`}>
            <CheckboxField
              checked={isOperationOn(op.permission)}
              on:change={() => toggleOperation(op.permission)}
              data-testid={`AdminGrantTab_op_${op.key}`}
            />
            <span class="optext">
              <span class="t">{_t(op.labelKey, { defaultMessage: op.defaultLabel })}</span>
              <span class="k">{op.permission}</span>
            </span>
          </div>
        {/each}

        <div class="limits">
          <FormFieldTemplateLarge label={t('maxRows', '最大行数')}>
            <TextField type="number" min="0" bind:value={grants.limits.maxRows} />
          </FormFieldTemplateLarge>
          <FormFieldTemplateLarge label={t('timeoutSeconds', '超时（秒）')}>
            <TextField type="number" min="0" bind:value={grants.limits.timeoutSeconds} />
          </FormFieldTemplateLarge>
          <FormFieldTemplateLarge label={t('allowedHours', '允许时段')}>
            <TextField placeholder="09:00-18:00" bind:value={grants.limits.allowedHours} />
          </FormFieldTemplateLarge>
          <FormFieldTemplateLarge label={t('allowedIps', '来源 IP 白名单')}>
            <TextField placeholder="10.20." bind:value={grants.limits.allowedIps} />
          </FormFieldTemplateLarge>
          <button class="btn" on:click={saveLimits} data-testid="AdminGrantTab_saveLimits">{t('save', '保存限制')}</button>
        </div>
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
  .summary {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 8px 10px;
    margin-bottom: 10px;
    border: 1px solid var(--theme-card-border);
    border-radius: 4px;
  }
  .grid {
    display: grid;
    grid-template-columns: minmax(200px, 0.75fr) minmax(300px, 1.35fr) minmax(290px, 1fr);
    gap: 12px;
    align-items: start;
  }
  .card {
    border: 1px solid var(--theme-card-border);
    border-radius: 4px;
    max-height: calc(100vh - 200px);
    overflow: auto;
  }
  .card h3 {
    margin: 0;
    padding: 6px 8px;
    border-bottom: 1px solid var(--theme-border);
    font-size: 13px;
    font-weight: 600;
  }
  .hint {
    font-weight: 400;
    color: var(--theme-generic-font-grayed);
    font-size: 11.5px;
  }
  ul.members {
    list-style: none;
    margin: 4px 0;
    padding: 0;
  }
  ul.members li.on,
  ul.members li:hover {
    background: var(--theme-table-selected-background);
  }
  .memberbtn {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    color: var(--theme-generic-font);
    cursor: pointer;
    padding: 5px 8px;
  }
  .who b {
    display: block;
    font-weight: 600;
  }
  .who span {
    display: block;
    color: var(--theme-generic-font-grayed);
    font-size: 11px;
  }
  .conn {
    margin: 6px 0;
  }
  .connhead {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    font-weight: 600;
  }
  .dbrow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 6px;
    margin: 0 4px;
    border-radius: 3px;
  }
  .dbrow:hover {
    background: var(--theme-table-selected-background);
  }
  .dbname {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .levels {
    display: flex;
    gap: 3px;
  }
  .levels button {
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 3px;
    cursor: pointer;
    border: 1px solid var(--theme-toolstrip-button-border);
    background: var(--theme-toolstrip-button-background);
    color: var(--theme-generic-font);
  }
  .levels button:hover {
    border-color: var(--theme-toolstrip-button-border-hover);
  }
  .levels button.on {
    background: var(--theme-link-foreground);
    border-color: var(--theme-link-foreground);
    color: #fff;
    font-weight: 600;
  }
  .opgroup {
    margin: 8px 8px 2px;
    font-size: 11.5px;
    color: var(--theme-generic-font-grayed);
  }
  .oprow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 8px;
    border-radius: 3px;
  }
  .oprow:hover {
    background: var(--theme-table-selected-background);
  }
  .optext {
    display: block;
  }
  .optext .t {
    display: block;
    font-size: 12.5px;
  }
  .optext .k {
    display: block;
    color: var(--theme-generic-font-grayed);
    font-size: 11px;
  }
  .limits {
    margin: 8px 8px 8px;
    border-top: 1px solid var(--theme-border);
    padding-top: 8px;
  }
  .tag {
    font-size: 11px;
    border-radius: 99px;
    padding: 1px 7px;
    border: 1px solid var(--theme-border);
    color: var(--theme-generic-font-grayed);
  }
  .tag.info {
    color: var(--theme-link-foreground);
    border-color: var(--theme-link-foreground);
  }
  .tag.warn {
    color: #b7791f;
    border-color: #b7791f;
  }
  .tag.bad {
    color: #c53030;
    border-color: #c53030;
  }
  .notice {
    padding: 8px 10px;
    border-radius: 4px;
    margin-bottom: 10px;
    font-size: 12.5px;
    border: 1px solid;
  }
  .notice.warn {
    border-color: #b7791f;
    color: #b7791f;
  }
  .muted {
    color: var(--theme-generic-font-grayed);
  }
  .error {
    color: #c53030;
    margin-bottom: 8px;
  }
</style>
