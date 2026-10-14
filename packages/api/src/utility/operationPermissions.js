// 「操作开关」：把已经真实生效的操作级权限点，翻译成管理者看得懂的开关。
//
// 判定约定：基线是「允许一切」（DSL 默认允许 + `*`），所以
//   开关关闭 = 在角色权限里加 `~<permission>`（显式拒绝）
//   开关开启 = 从角色权限里删掉 `~<permission>`
// 这样开关只做一件事：加/去掉一条 deny，不需要往角色里堆 allow。
//
// ★ 这份清单里每一个 permission 都必须能在 packages/api/src 里找到真实的强制点，
//   由 operationPermissions.test.js 扫源码守卫。加开关前先加权限点，别造空开关。

const OPERATION_PERMISSIONS = [
  {
    key: 'query',
    permission: 'dbops/query',
    labelKey: 'admin.operations.query',
    defaultLabel: 'Run queries',
    description: 'Execute SQL from the query tab and the session API.',
  },
  {
    key: 'sqlDumpExport',
    permission: 'dbops/sql-dump/export',
    labelKey: 'admin.operations.sqlDumpExport',
    defaultLabel: 'Export data (SQL dump)',
    description: 'Dump tables or whole databases to a file.',
  },
  {
    key: 'sqlDumpImport',
    permission: 'dbops/sql-dump/import',
    labelKey: 'admin.operations.sqlDumpImport',
    defaultLabel: 'Import data (SQL dump)',
    description: 'Load a SQL dump into a database.',
  },
  {
    key: 'serverChat',
    permission: 'dbops/chat',
    labelKey: 'admin.operations.serverChat',
    defaultLabel: 'Server-level SQL chat',
    description: 'Ask questions across all databases of a connection.',
  },
  {
    key: 'shellScript',
    permission: 'run-shell-script',
    labelKey: 'admin.operations.shellScript',
    defaultLabel: 'Run shell scripts',
    description: 'Execute scripts on the server through the shell runner.',
  },
  {
    key: 'archiveWrite',
    permission: 'archive/write',
    labelKey: 'admin.operations.archiveWrite',
    defaultLabel: 'Write to archive',
    description: 'Create, modify or delete files in the archive folders.',
  },
  {
    key: 'pluginInstall',
    permission: 'plugins/install',
    labelKey: 'admin.operations.pluginInstall',
    defaultLabel: 'Install plugins',
    description: 'Install or update database driver plugins.',
  },
  {
    key: 'pluginCommand',
    permission: 'plugins/command',
    labelKey: 'admin.operations.pluginCommand',
    defaultLabel: 'Run plugin commands',
    description: 'Invoke commands exposed by plugins.',
  },
  {
    key: 'appsWrite',
    permission: 'apps/write',
    labelKey: 'admin.operations.appsWrite',
    defaultLabel: 'Edit applications',
    description: 'Create and modify saved applications.',
  },
  {
    key: 'settingsChange',
    permission: 'settings/change',
    labelKey: 'admin.operations.settingsChange',
    defaultLabel: 'Change settings',
    description: 'Change global application settings.',
  },
  {
    key: 'applicationLog',
    permission: 'application-log',
    labelKey: 'admin.operations.applicationLog',
    defaultLabel: 'Read the application log',
    description: 'Read the server-side application log.',
  },
];

function getOperationPermissions() {
  return OPERATION_PERMISSIONS.map(x => ({ ...x }));
}

module.exports = {
  OPERATION_PERMISSIONS,
  getOperationPermissions,
};
