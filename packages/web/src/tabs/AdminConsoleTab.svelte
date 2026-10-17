<script lang="ts">
  import { onMount } from 'svelte';
  import { apiCall } from '../utility/api';
  import AdminOverviewTab from './AdminOverviewTab.svelte';
  import AdminV2RolesTab from './AdminV2RolesTab.svelte';
  import AdminAuditTab from './AdminAuditTab.svelte';
  import AdminUsersPageTab from './AdminUsersPageTab.svelte';
  import AdminMatrixPageTab from './AdminMatrixPageTab.svelte';
  import AdminPreviewPageTab from './AdminPreviewPageTab.svelte';
  import AdminAuthPageTab from './AdminAuthPageTab.svelte';

  // ============================================================
  // 按产品原型（prototype/dbgate-permissions/index.html）重写的整套管理 UI：
  //   [dbgate rail 保留] + [250px 侧栏：管理/7 个 section/说明] + [内容区]
  //   CSS 直接照搬原型（自成一套设计变量，不掺 dbgate 主题）
  // ============================================================
  export const matchingProps = [];

  const SECTIONS = [
    { id: 'overview', name: '概览' },
    { id: 'users', name: '用户' },
    { id: 'roles', name: '角色与授权' },
    { id: 'matrix', name: '访问矩阵' },
    { id: 'preview', name: '权限预览 / 模拟' },
    { id: 'audit', name: '审计日志' },
    { id: 'auth', name: '登录 / 成员来源' },
  ];

  let section = 'overview';
  let railWidth = 50;
  let me = '';

  onMount(async () => {
    // 量最外层 rail 的真实宽度：全屏层要从它右边开始，否则会漏出一条浅色缝
    const btn = [...document.querySelectorAll('[title]')].find(e => e.getAttribute('title') === 'Administration');
    let el = btn;
    while (el && el.parentElement) {
      const r = el.getBoundingClientRect();
      if (r.width > 20 && r.width < 90 && r.height > 300) {
        railWidth = Math.round(r.right);
        break;
      }
      el = el.parentElement;
    }
    const resp = await apiCall('config/get');
    me = resp?.login ?? '';
  });

  $: current = SECTIONS.find(s => s.id === section) ?? SECTIONS[0];
</script>

<div class="console" data-testid="AdminConsole">
  <div class="topbar">
    <div class="logo"><span class="dot"></span> DbGate 管理控制台</div>
    <span class="proto-badge">团队权限</span>
    <div class="grow"></div>
    {#if me}<span class="user-chip">{me}</span>{/if}
  </div>

  <div class="body">
    <div class="side">
      <div class="side-head"><span class="ic">▣</span><span class="t">管理</span></div>
      <div class="side-body">
        {#each SECTIONS as s (s.id)}
          <div
            class="side-item"
            class:active={section === s.id}
            on:click={() => (section = s.id)}
            on:keydown={e => e.key === 'Enter' && (section = s.id)}
            role="button"
            tabindex="0"
            data-testid={`ConsoleNav_${s.id}`}>{s.name}</div
          >
        {/each}
        <div class="side-note">
          配置写入 <span class="mono">~/.dbgate/</span>；环境变量用户与 <span class="mono">PERMISSIONS</span> 仍然兼容。
        </div>
      </div>
    </div>

    <div class="main">
      <div class="crumb">管理 <span class="sub">› {current.name}</span></div>
      <div class="content">
        {#if section === 'overview'}
          <AdminOverviewTab />
        {:else if section === 'roles'}
          <AdminV2RolesTab />
        {:else if section === 'audit'}
          <AdminAuditTab />
        {:else if section === 'users'}
          <AdminUsersPageTab />
        {:else if section === 'matrix'}
          <AdminMatrixPageTab />
        {:else if section === 'preview'}
          <AdminPreviewPageTab />
        {:else if section === 'auth'}
          <AdminAuthPageTab />
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .console {
    --rail: #15181d;
    --side: #1b1f26;
    --bg: #21252c;
    --panel: #262b33;
    --panel2: #2c323c;
    --border: #383f4a;
    --text: #e8ebf1;
    --muted: #98a2b3;
    --accent: #2f86e0;
    --accent2: #2268b4;
    --green: #2ea043;
    --amber: #d29922;
    --red: #da3633;
    --purple: #8957e5;
    --radius: 6px;
    --shadow: 0 14px 40px rgba(0, 0, 0, 0.45);
    /* 只覆盖内容区：左侧 rail 保留 */
    /* 正常流式：占满页签内容区，绝不 fixed 覆盖（否则会挡住数据库连接等原有功能） */
    position: relative;
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
    font: 13px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .topbar {
    height: 46px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 14px;
    background: var(--side);
    border-bottom: 1px solid var(--border);
  }
  .logo {
    display: flex;
    align-items: center;
    gap: 9px;
    font-weight: 700;
    letter-spacing: 0.2px;
  }
  .logo .dot {
    width: 18px;
    height: 18px;
    border-radius: 5px;
    background: linear-gradient(135deg, var(--accent), var(--purple));
  }
  .proto-badge {
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 999px;
    color: #ffd479;
    border: 1px solid #ffd47955;
    background: #ffd47914;
  }
  .grow {
    flex: 1;
  }
  .user-chip {
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--panel2);
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .side {
    width: 250px;
    flex: none;
    background: var(--side);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .side-head {
    padding: 10px 12px 8px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .side-head .t {
    font-weight: 600;
  }
  .ic {
    width: 18px;
    text-align: center;
    opacity: 0.85;
  }
  .side-body {
    overflow: auto;
    padding: 8px;
    flex: 1;
  }
  .side-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 9px;
    border-radius: var(--radius);
    cursor: pointer;
    border: 1px solid transparent;
    color: var(--text);
  }
  .side-item:hover {
    background: var(--panel2);
  }
  .side-item.active {
    background: var(--panel2);
    border-color: var(--border);
    color: var(--accent);
    font-weight: 600;
  }
  .side-note {
    margin-top: 10px;
    padding-top: 9px;
    border-top: 1px solid var(--border);
    font-size: 11.5px;
    color: var(--muted);
    line-height: 1.55;
    padding-left: 9px;
    padding-right: 9px;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .crumb {
    height: 34px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px;
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
    background: var(--side);
  }
  .sub {
    color: var(--muted);
    font-size: 12px;
  }
  .content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 16px;
  }
  .content :global(> *) {
    min-height: 0;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px;
  }
  h2 {
    font-size: 14px;
    margin: 0 0 10px;
  }
  .empty {
    padding: 22px;
    text-align: center;
    color: var(--muted);
    border: 1px dashed var(--border);
    border-radius: 8px;
  }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11.5px;
  }
</style>
