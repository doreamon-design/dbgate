<script lang="ts" context="module">
  export const matchingProps = [];
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { apiCall } from '../utility/api';
  import { _t } from '../translations';
  import LoadingInfo from '../elements/LoadingInfo.svelte';
  import FontIcon from '../icons/FontIcon.svelte';
  // 用仓库自带的表单组件排版（不再自造 div+label+CSS —— 之前那样会出现
  // 控件被拉满整行、标签跑到控件后面与邻列重叠的问题）
  import FormFieldTemplateLarge from '../forms/FormFieldTemplateLarge.svelte';
  import CheckboxField from '../forms/CheckboxField.svelte';
  import TextField from '../forms/TextField.svelte';

  let isLoading = true;
  let errorMessage = '';
  let roles = [];
  let users = [];
  let connections = [];
  let databaseRoles = [];
  let tableRoles = [];
  let tableScopes = [];
  let operationPermissions = [];
  let columnMaskModes = [];
  let rowFilterUserFields = [];
  let rowFilterOperators = [];
  let selectedRoleId = null;
  let draft: any = null;
  let grants = { all: false, ids: [] };
  let dbRules = [];
  let objRules = [];
  let colRules = [];
  let rowFilterRules = [];

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
    if (!checkError(optResp)) {
      databaseRoles = optResp?.databaseRoles ?? [];
      tableRoles = optResp?.tableRoles ?? [];
      tableScopes = optResp?.tableScopes ?? [];
      operationPermissions = optResp?.operationPermissions ?? [];
      columnMaskModes = optResp?.columnMaskModes ?? [];
      rowFilterUserFields = optResp?.rowFilterUserFields ?? [];
      rowFilterOperators = optResp?.rowFilterOperators ?? [];
    }
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
      limits: {
        maxRows: resp.role.limits?.maxRows ?? 0,
        timeoutSeconds: resp.role.limits?.timeoutSeconds ?? 0,
        allowedHours: resp.role.limits?.allowedHours ?? '',
        allowedIps: resp.role.limits?.allowedIps ?? '',
      },
    };
    grants = { all: !!resp.role.connections?.all, ids: (resp.connections ?? []).map(x => x.connection_id) };
    dbRules = (resp.databases ?? []).map(x => ({ ...x }));
    objRules = (resp.tables ?? []).map(x => ({ ...x }));
    colRules = (resp.columns ?? []).map(x => ({ ...x }));
    rowFilterRules = (resp.rowFilters ?? []).map(x => ({ ...x }));
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

  function addObjRule() {
    objRules = [
      ...objRules,
      {
        connection_id: connections[0]?.conid ?? '',
        database_names_list: '',
        schema_names_list: '',
        table_names_list: '',
        table_permission_scope_id: -2,
        table_permission_role_id: -1,
      },
    ];
  }

  function removeObjRule(index) {
    objRules = objRules.filter((_, i) => i !== index);
  }

  function addColRule() {
    colRules = [
      ...colRules,
      {
        connection_id: connections[0]?.conid ?? '',
        database_names_list: '',
        table_names_list: '',
        column_names_list: '',
        column_mask_mode: columnMaskModes[0] ?? 'partial',
      },
    ];
  }

  function removeColRule(index) {
    colRules = colRules.filter((_, i) => i !== index);
  }

  function addRowFilter() {
    rowFilterRules = [
      ...rowFilterRules,
      {
        connection_id: connections[0]?.conid ?? '',
        database_names_list: '',
        table_names_list: '',
        column_name: '',
        filter_operator: '=',
        value_type: 'user',
        user_field: rowFilterUserFields[0] ?? 'login',
        filter_value: '',
      },
    ];
  }

  function removeRowFilter(index) {
    rowFilterRules = rowFilterRules.filter((_, i) => i !== index);
  }

  // 操作开关只改权限串里的一条 deny：
  //   关闭 = 加 `~<permission>`（基线是「允许一切」，所以拒绝必须显式写）
  //   开启 = 删掉这条 deny
  function permissionLines() {
    return (draft?.permissionsText ?? '')
      .split('\n')
      .map(x => x.trim())
      .filter(Boolean);
  }

  function isOperationDenied(permission) {
    return permissionLines().includes(`~${permission}`);
  }

  function toggleOperation(permission) {
    const lines = permissionLines();
    const deny = `~${permission}`;
    draft.permissionsText = (lines.includes(deny) ? lines.filter(x => x !== deny) : [...lines, deny]).join('\n');
  }

  async function save() {
    errorMessage = '';
    const resp = await apiCall('permissions/save-role-detail', {
      role: {
        id: draft.id,
        name: draft.name,
        description: draft.description,
        limits: draft.limits,
        permissions: draft.permissionsText
          .split('\n')
          .map(x => x.trim())
          .filter(Boolean),
      },
      connections: { all: grants.all, ids: grants.ids },
      databases: dbRules,
      tables: objRules,
      columns: colRules,
      rowFilters: rowFilterRules,
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
            role="button"
            tabindex="0"
            on:click={() => selectRole(role.id)}
            on:keydown={event => event.key === 'Enter' && selectRole(role.id)}
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

          {#if operationPermissions.length}
            <h3>{t('operations', 'Operations')}</h3>
            <div class="note">
              {t(
                'operationsNote',
                'Switches write an explicit deny into the permission list above. Every switch is backed by a real check in the API.'
              )}
            </div>
            {#each operationPermissions as op (op.key)}
              <FormFieldTemplateLarge
                type="checkbox"
                label={_t(op.labelKey, { defaultMessage: op.defaultLabel })}
                labelProps={{ title: op.permission }}
              >
                <CheckboxField
                  checked={!isOperationDenied(op.permission)}
                  disabled={isBuiltin(draft)}
                  on:change={() => toggleOperation(op.permission)}
                  data-testid={`AdminRolesTab_operation_${op.key}`}
                />
              </FormFieldTemplateLarge>
            {/each}
          {/if}

          <h3>{t('limits', 'Usage limits')}</h3>
          <div class="note">
            {t(
              'limitsNote',
              'Enforced on every database request. A member with several roles gets the strictest values; 0 or empty means no limit.'
            )}
          </div>
          <FormFieldTemplateLarge label={t('maxRows', 'Max rows')}>
            <TextField type="number" min="0" bind:value={draft.limits.maxRows} data-testid="AdminRolesTab_maxRows" />
          </FormFieldTemplateLarge>
          <FormFieldTemplateLarge label={t('timeoutSeconds', 'Timeout (s)')}>
            <TextField
              type="number"
              min="0"
              bind:value={draft.limits.timeoutSeconds}
              data-testid="AdminRolesTab_timeoutSeconds"
            />
          </FormFieldTemplateLarge>
          <FormFieldTemplateLarge label={t('allowedHours', 'Allowed hours')}>
            <TextField placeholder="09:00-18:00" bind:value={draft.limits.allowedHours} data-testid="AdminRolesTab_allowedHours" />
          </FormFieldTemplateLarge>
          <FormFieldTemplateLarge label={t('allowedIps', 'Allowed IPs')}>
            <TextField
              placeholder="10.20., 203.0.113.7"
              bind:value={draft.limits.allowedIps}
              data-testid="AdminRolesTab_allowedIps"
            />
          </FormFieldTemplateLarge>

          <h3>{t('connections', 'Connections')}</h3>
          <FormFieldTemplateLarge
            type="checkbox"
            label={t('allConnections', 'All connections (including future ones)')}
          >
            <CheckboxField
              checked={grants.all}
              on:change={e => (grants = { ...grants, all: e.target.checked })}
              data-testid="AdminRolesTab_allConnections"
            />
          </FormFieldTemplateLarge>
          {#if !grants.all}
            {#each connections as conn (conn.conid)}
              <FormFieldTemplateLarge type="checkbox" label={`${conn.name} (${conn.engine})`}>
                <CheckboxField
                  checked={grants.ids.includes(conn.conid)}
                  on:change={() => toggleConnection(conn.conid)}
                  data-testid={`AdminRolesTab_conn_${conn.conid}`}
                />
              </FormFieldTemplateLarge>
            {/each}
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

          <h3>
            {t('objects', 'Object overrides')}
            <button class="btn small" on:click={addObjRule} data-testid="AdminRolesTab_addObjectRule">
              <FontIcon icon="icon add" />
            </button>
          </h3>
          <div class="note">
            {t(
              'objectsNote',
              'Database levels are pushed down to objects (read only → read, read-write → create/update/delete, script → run_script). Only add exceptions here.'
            )}
          </div>
          <table class="tbl" data-testid="AdminRolesTab_objectRules">
            <thead>
              <tr>
                <th>{t('connection', 'Connection')}</th>
                <th>{t('database', 'Database')}</th>
                <th>{t('scope', 'Scope')}</th>
                <th>{t('objectsList', 'Objects (comma separated)')}</th>
                <th>{t('objectRole', 'Object level')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {#each objRules as rule, index}
                <tr data-testid={`AdminRolesTab_objRule_${index}`}>
                  <td>
                    <select bind:value={rule.connection_id}>
                      {#each connections as conn (conn.conid)}
                        <option value={conn.conid}>{conn.name}</option>
                      {/each}
                    </select>
                  </td>
                  <td>
                    <input type="text" bind:value={rule.database_names_list} placeholder="order_db" />
                  </td>
                  <td>
                    <select bind:value={rule.table_permission_scope_id} data-testid={`AdminRolesTab_objScope_${index}`}>
                      {#each tableScopes as scope (scope.id)}
                        <option value={scope.id}>{scope.name}</option>
                      {/each}
                    </select>
                  </td>
                  <td>
                    <input
                      type="text"
                      bind:value={rule.table_names_list}
                      placeholder="orders, order_items"
                      data-testid={`AdminRolesTab_objNames_${index}`}
                    />
                  </td>
                  <td>
                    <select bind:value={rule.table_permission_role_id} data-testid={`AdminRolesTab_objLevel_${index}`}>
                      {#each tableRoles as role (role.id)}
                        <option value={role.id}>{role.name}</option>
                      {/each}
                    </select>
                  </td>
                  <td>
                    <button class="btn small" on:click={() => removeObjRule(index)}>
                      <FontIcon icon="icon delete" />
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if !objRules.length}
            <div class="note">{t('noObjectRules', 'No object overrides: everything inherits the database level.')}</div>
          {/if}

          <h3>
            {t('columnMasks', 'Column masks')}
            <button class="btn small" on:click={addColRule} data-testid="AdminRolesTab_addColumnRule">
              <FontIcon icon="icon add" />
            </button>
          </h3>
          <div class="note">
            {t(
              'columnMasksNote',
              'Hide a column entirely, keep only its first/last characters, hash it, or blank it out. Applied to query results before they leave the server.'
            )}
          </div>
          <table class="tbl" data-testid="AdminRolesTab_columnRules">
            <thead>
              <tr>
                <th>{t('connection', 'Connection')}</th>
                <th>{t('database', 'Database')}</th>
                <th>{t('table', 'Table')}</th>
                <th>{t('columns', 'Columns (comma separated)')}</th>
                <th>{t('maskMode', 'Mask')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {#each colRules as rule, index}
                <tr data-testid={`AdminRolesTab_colRule_${index}`}>
                  <td>
                    <select bind:value={rule.connection_id}>
                      {#each connections as conn (conn.conid)}
                        <option value={conn.conid}>{conn.name}</option>
                      {/each}
                    </select>
                  </td>
                  <td><input type="text" bind:value={rule.database_names_list} placeholder="order_db" /></td>
                  <td><input type="text" bind:value={rule.table_names_list} placeholder="customers" /></td>
                  <td>
                    <input
                      type="text"
                      bind:value={rule.column_names_list}
                      placeholder="phone, id_card"
                      data-testid={`AdminRolesTab_colNames_${index}`}
                    />
                  </td>
                  <td>
                    <select bind:value={rule.column_mask_mode} data-testid={`AdminRolesTab_colMode_${index}`}>
                      {#each columnMaskModes as mode (mode)}
                        <option value={mode}>{mode}</option>
                      {/each}
                    </select>
                  </td>
                  <td>
                    <button class="btn small" on:click={() => removeColRule(index)}>
                      <FontIcon icon="icon delete" />
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if !colRules.length}
            <div class="note">{t('noColumnRules', 'No column masks.')}</div>
          {/if}

          <h3>
            {t('rowFilters', 'Row filters')}
            <button class="btn small" on:click={addRowFilter} data-testid="AdminRolesTab_addRowFilter">
              <FontIcon icon="icon add" />
            </button>
          </h3>
          <div class="note">
            {t(
              'rowFiltersNote',
              'Rows are restricted by injecting this condition into table browsing. Running raw SQL or scripts is refused for such databases — otherwise the filter could simply be bypassed.'
            )}
          </div>
          <table class="tbl" data-testid="AdminRolesTab_rowFilters">
            <thead>
              <tr>
                <th>{t('connection', 'Connection')}</th>
                <th>{t('database', 'Database')}</th>
                <th>{t('table', 'Table')}</th>
                <th>{t('column', 'Column')}</th>
                <th>{t('operator', 'Op')}</th>
                <th>{t('valueFrom', 'Value from')}</th>
                <th>{t('value', 'Value')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {#each rowFilterRules as rule, index}
                <tr data-testid={`AdminRolesTab_rowFilter_${index}`}>
                  <td>
                    <select bind:value={rule.connection_id}>
                      {#each connections as conn (conn.conid)}
                        <option value={conn.conid}>{conn.name}</option>
                      {/each}
                    </select>
                  </td>
                  <td><input type="text" bind:value={rule.database_names_list} placeholder="order_db" /></td>
                  <td><input type="text" bind:value={rule.table_names_list} placeholder="customers" /></td>
                  <td>
                    <input
                      type="text"
                      bind:value={rule.column_name}
                      placeholder="tenant"
                      data-testid={`AdminRolesTab_rowFilterColumn_${index}`}
                    />
                  </td>
                  <td>
                    <select bind:value={rule.filter_operator} data-testid={`AdminRolesTab_rowFilterOp_${index}`}>
                      {#each rowFilterOperators as op (op)}
                        <option value={op}>{op}</option>
                      {/each}
                    </select>
                  </td>
                  <td>
                    <select bind:value={rule.value_type} data-testid={`AdminRolesTab_rowFilterType_${index}`}>
                      <option value="user">{t('member', 'member')}</option>
                      <option value="literal">{t('literal', 'literal')}</option>
                    </select>
                  </td>
                  <td>
                    {#if rule.value_type === 'user'}
                      <select bind:value={rule.user_field} data-testid={`AdminRolesTab_rowFilterField_${index}`}>
                        {#each rowFilterUserFields as field (field)}
                          <option value={field}>{field}</option>
                        {/each}
                      </select>
                    {:else}
                      <input type="text" bind:value={rule.filter_value} placeholder="ACME" />
                    {/if}
                  </td>
                  <td>
                    <button class="btn small" on:click={() => removeRowFilter(index)}>
                      <FontIcon icon="icon delete" />
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if !rowFilterRules.length}
            <div class="note">{t('noRowFilters', 'No row filters.')}</div>
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
    border: var(--theme-table-border);
    border-radius: 4px;
  }
  .list .head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: var(--theme-table-border);
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
  .operation .sub {
    display: block;
    font-size: 11px;
    opacity: 0.6;
  }
  .tbl {
    width: 100%;
    border-collapse: collapse;
  }
  .tbl th,
  .tbl td {
    text-align: left;
    padding: 4px 6px;
    border-bottom: var(--theme-table-border);
  }
  .tag {
    display: inline-block;
    padding: 0 6px;
    border: var(--theme-table-border);
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
