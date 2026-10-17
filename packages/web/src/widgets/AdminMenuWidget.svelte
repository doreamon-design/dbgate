<script lang="ts">
  import { _t } from '../translations';
  import openNewTab from '../utility/openNewTab';
  import hasPermission from '../utility/hasPermission';
  import WidgetsInnerContainer from './WidgetsInnerContainer.svelte';
  import FontIcon from '../icons/FontIcon.svelte';

  // 按产品原型（prototype/dbgate-permissions/index.html）的左面板做：
  // 「管理」标题 + 图标 + 7 个 section + 底部说明。
  // 外层 rail（数据库/文件/历史/插件/管理）保持 dbgate 原样不动。
  const items = [
    {
      tabComponent: 'AdminConsoleTab',
      permission: 'admin/users',
      icon: 'img admin',
      titleKey: 'admin.console.title',
      titleDefault: 'Management console',
    },
  ];

  function open(item) {
    openNewTab({
      tabComponent: item.tabComponent,
      title: _t(item.titleKey, { defaultMessage: item.titleDefault }),
      icon: item.icon,
      props: {},
    });
  }
</script>

{#if hasPermission('admin/users') || hasPermission('admin/roles') || hasPermission('admin/auditlog')}
  <WidgetsInnerContainer>
    <div class="admin-panel" data-testid="AdminMenu">
      <div class="admin-head">
        <FontIcon icon="img admin" />
        <span>管理</span>
      </div>

      <div class="admin-items">
        {#each items as item}
          {#if hasPermission(item.permission)}
            <div
              class="admin-menu-item"
              role="button"
              tabindex="0"
              on:click={() => open(item)}
              on:keydown={event => event.key === 'Enter' && open(item)}
              data-testid={`AdminMenu_${item.tabComponent}`}
            >
              <FontIcon icon={item.icon} />
              <span>{_t(item.titleKey, { defaultMessage: item.titleDefault })}</span>
            </div>
          {/if}
        {/each}
      </div>

      <div class="admin-note">
        配置写入 <span class="mono">~/.dbgate/</span>；环境变量用户与 <span class="mono">PERMISSIONS</span> 仍然兼容。
      </div>
    </div>
  </WidgetsInnerContainer>
{:else}
  Sorry, administration is not available
{/if}

<style>
  .admin-panel {
    display: flex;
    flex-direction: column;
    padding: 2px 2px 6px;
  }
  .admin-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 4px 9px;
    margin-bottom: 6px;
    border-bottom: 1px solid rgba(128, 128, 128, 0.25);
    font-weight: 600;
  }
  .admin-items {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .admin-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 9px;
    border-radius: 6px;
    border: 1px solid transparent;
    cursor: pointer;
  }
  .admin-menu-item:hover {
    background: rgba(128, 128, 128, 0.16);
  }
  .admin-menu-item:focus-visible {
    outline: 1px solid #2f86e0;
    outline-offset: -1px;
  }
  .admin-note {
    margin-top: 10px;
    padding-top: 9px;
    border-top: 1px solid rgba(128, 128, 128, 0.2);
    font-size: 11.5px;
    line-height: 1.55;
    opacity: 0.72;
  }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11.5px;
  }
</style>
