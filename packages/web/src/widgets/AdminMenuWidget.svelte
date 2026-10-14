<script lang="ts">
  import { _t } from '../translations';
  import openNewTab from '../utility/openNewTab';
  import hasPermission from '../utility/hasPermission';
  import WidgetsInnerContainer from './WidgetsInnerContainer.svelte';
  import FontIcon from '../icons/FontIcon.svelte';

  const items = [
    {
      tabComponent: 'AdminGrantTab',
      permission: 'admin/users',
      icon: 'img key',
      titleKey: 'admin.grant.title',
      titleDefault: 'Grant access',
    },
    {
      tabComponent: 'AdminUsersTab',
      permission: 'admin/users',
      icon: 'img user',
      titleKey: 'admin.users.title',
      titleDefault: 'Members',
    },
    {
      tabComponent: 'AdminRolesTab',
      permission: 'admin/roles',
      icon: 'img lock',
      titleKey: 'admin.roles.title',
      titleDefault: 'Roles & permissions',
    },
    {
      tabComponent: 'AdminMatrixTab',
      permission: 'admin/users',
      icon: 'img table',
      titleKey: 'admin.matrix.title',
      titleDefault: 'Access matrix',
    },
    {
      tabComponent: 'AdminAccessPreviewTab',
      permission: 'admin/users',
      icon: 'img eye',
      titleKey: 'admin.access.title',
      titleDefault: 'Access preview',
    },
    {
      tabComponent: 'AdminAuthTab',
      permission: 'admin/users',
      icon: 'img key',
      titleKey: 'admin.auth.title',
      titleDefault: 'Login & member sources',
    },
    {
      tabComponent: 'AppLogTab',
      permission: 'admin/auditlog',
      icon: 'img history',
      titleKey: 'admin.auditlog.title',
      titleDefault: 'Audit log',
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
  </WidgetsInnerContainer>
{:else}
  Sorry, administration is not available
{/if}

<style>
  .admin-menu-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    cursor: pointer;
    border-radius: 3px;
  }
  .admin-menu-item:hover {
    background: var(--theme-bg-hover, rgba(128, 128, 128, 0.15));
  }
</style>
