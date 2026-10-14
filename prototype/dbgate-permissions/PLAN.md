# DbGate 团队权限管理 · 设计说明与研发计划 v0.1

> 配套可点原型：`prototype/dbgate-permissions/index.html`（纯静态单文件，无外部依赖）
> 本文所有结论都来自当前仓库代码，已标注文件与行号，便于逐条核对。

---

## 0. 一句话方案

**把"角色 → 连接 → 数据库 → 对象 → 行/列"五级授权做成管理界面，落在社区版自己的文件存储上，复用已有的权限引擎（`hasPermission.js` + `testPermission.ts`），不新建一套并行体系。**

成员用自己的账号登录，不再共用数据库密码；管理员在网页上按岗位配角色，默认拒绝、按需开库；成员只看到自己有权限的连接与库。

---

## 1. 现状：读完代码后的结论

### 1.1 认证：社区版其实是"多登录名 + 单管理员"，但没有用户对象

- 认证方式由环境变量决定：`LOGIN`/`PASSWORD`、`LOGIN_PASSWORD_<login>`、`AD_*`、`OAUTH_*`，见 `packages/api/src/auth/authProvider.js:305-320`（`detectEnvAuthProviderCore`）。
- 也就是说**多人登录是支持的**：`LOGIN_PASSWORD_alice=xxx` 就能多一个人。但：
  - 用户不是数据，是进程环境变量 —— 加人/改密码/停用都要改配置并**重启**；
  - 没有用户列表、没有停用、没有有效期、没有"这个人什么时候登的"；
  - 前端没有任何成员管理界面。
- 社区版没有 storage 数据库时，API 靠 basic auth 或 JWT 保护，见 `packages/api/src/auth/authCommon.js`（`isBasicAuthActive`：`BASIC_AUTH && !STORAGE_DATABASE`）。

### 1.2 授权：引擎已经有了，但数据库级授权被 `STORAGE_DATABASE` 关在门外

已有的权限字符串 DSL（`packages/tools/src/testPermission.ts`）：

- `compilePermissions` / `testPermission`：**默认允许**、`*` 通配、`~` 前缀为拒绝、顺序匹配后者覆盖前者（`:19`、`:66`）。
- 预置角色 `superadmin` / `logged-user` / `anonymous-user` 的权限串，见 `:107-134`。

已有的数据库/对象级授权（`packages/api/src/utility/hasPermission.js`）：

| 概念 | 取值 | 代码位置 |
|---|---|---|
| 数据库档位 | `view` / `read_content` / `write_data` / `run_script` / `deny` | `:170-176` |
| 对象档位 | `read` / `update_only` / `create_update_delete` / `run_script` / `deny` | `:249-255` |
| 对象范围 | `tables` / `views` / `procedures` / `functions` / `triggers` / `collections` / `sql_objects` | `:257-267` |
| 规则匹配 | 名称列表（换行分隔，忽略大小写）或正则；连接 + 库 + schema + 表 | `:98-147` |
| 档位继承 | 库档位自动下推到对象（只读→`read`，读写→`create_update_delete`，脚本→`run_script`） | `:269-285` |

**关键限制**：这一整套只在 `process.env.STORAGE_DATABASE` 存在时才生效 —— `testConnectionPermission`（`:42-66`）与 `testDatabaseRolePermission`（`:335-350`）第一行就短路了。社区版没有 storage 数据库，所以：

- 现在社区版只能靠 `PERMISSIONS` / `LOGIN_PERMISSIONS_<login>` 这种**连接级**通配串；
- **"张三只能看 order_db，李四只能看 pay_db"这种需求，社区版今天做不到**，必须上 Team Premium。

### 1.3 社区版仓库里已经埋好了"接缝"，以及一堆 Premium 残留

这说明社区版是团队版在**同一批路径上被降级**的结果，不是另起炉灶：

| 文件 | 现状 |
|---|---|
| `packages/web/src/widgets/AdminMenuWidget.svelte:1` | 整个文件就一行：`Sorry, administration is not available` —— "管理"面板在社区版是个占位符 |
| `packages/api/src/controllers/storage.js` | 一组返回 `null` / `[]` 的桩函数（含 `storageReadRolePermissions`、`readComplexRolePermissions`、`resolvePermissionConnectionIds`） |
| `packages/api/src/controllers/storage.test.js:64-88` | **Premium 管理端 24 条路由 × 所需 `admin/*` 权限的完整对照表**（`getUserList → admin/users`、`getRoleList → admin/roles`、`getAuditLog → admin/auditlog` …） |
| `packages/web/src/admin/FolderPermissionChooser.svelte:2` | `import PermissionCheckBox from './PermissionCheckBox.svelte'` —— 这个组件在社区版**不存在**，坏导入 |
| `packages/web/src/tabs/AppLogTab.svelte:358` | 审计日志页已存在，testid 前缀就是 `AdminAuditLogTab_` |
| `packages/api/src/controllers/storage.js` 的 `storageDb` / `auth/storageAuthProvider.js` | 社区版缺失（仅测试文件在 mock 它们） |

**结论：这个需求不是"从零加权限"，而是"把已经设计好的权限模型，在社区版用本地存储点亮，并补上管理界面"。**

### 1.4 所以缺的是三件事

1. **权限存储**：用户/角色/授权规则从哪来、存哪（社区版没有 storage 数据库）。
2. **管理界面**：把 `AdminMenuWidget` 的占位符换成真的"用户/角色/授权/审计"。
3. **更细的一层**：行级、列级、操作级、时段/IP —— 现有引擎完全没有，这是"更进一步"的部分。

---

## 2. 产品主张：三条原则 + 四层模型

### 2.1 三条原则

1. **默认拒绝**：连接授权只是前提；库/对象没命中任何规则 = 无权限。
   与现有后端默认值一致（`getDatabasePermissionRole` 初值是 `deny`，`:227-236`）。
2. **拒绝优先**：任一角色显式 `deny`，该库对该成员不可见，不允许别的角色"提权"回来。
3. **权限只从角色来**：成员不直接挂权限。人员变动只改一行"成员→角色"；权限评审只看角色；审计能回答"他是通过哪个角色拿到这个库的"。

### 2.2 四层模型（自上而下逐层收窄）

| 层 | 管什么 | 取值 | 对应现有实现 |
|---|---|---|---|
| **1 连接** | 能不能看到/连上这台服务器 | 授权 / 未授权、`all-connections` | `connections/<conid>` 串、`role_connections` 表 |
| **2 数据库** | 这台服务器里能看到哪些库、能做什么 | 无权限 / 可见 / 只读 / 读写 / 执行脚本 | `getDatabasePermissionRole`、`role_databases` 表 |
| **3 对象** | 库内某张表/视图/过程的例外 | `read`/`update_only`/`create_update_delete`/`run_script`/`deny`，范围 `tables`/`views`/… | `getTablePermissionRole`、`role_tables` 表 |
| **4 细粒度** | 行级过滤、列级脱敏、行数/超时/时段/IP、操作开关 | WHERE 表达式、隐藏/部分保留/哈希/置空、开关 | **全新**（见 §6 P2） |

### 2.3 一个必须写进代码注释的坑

`hasPermission('all-databases')` 在 `testDatabaseRolePermission`（`:340`）里是**短路返回白名单**。而预置 `logged-user` 权限串（`testPermission.ts:112-120`）里既没 deny `all-databases`，也没 deny 隐含项 —— DSL 又是默认允许。所以：

> **团队模式的权限基线必须显式 `~all-databases`、`~all-connections`**，否则任何人都会命中 `all-databases` 短路、拿到全库权限，角色规则形同虚设。

原型里已经按这个基线实现（`BASE_PERMISSIONS`），并且写了注释。

### 2.4 细粒度的实现边界（别在原型上过度承诺）

- **列级脱敏**：可以在结果流里做（`packages/api/src/shell/` 的 transform 管道），风险低。
- **行级过滤**：要靠 SQL 改写。DbGate 自带 `packages/sqltree`（SQL AST + `dumpSql`），对 SELECT/UPDATE/DELETE 注入 WHERE 是可行的。
- **但"执行脚本"档位在原理上无法保证拦住** —— 成员拿到 `run_script` 就能执行任意 SQL。
  **所以：配了行级过滤的库，建议同时关掉"执行脚本"档位。** 这条要写进 UI 提示和文档，不能藏。

---

## 3. 信息架构与交互（对应原型）

原型整体是 DbGate 的外壳（顶栏 + 左侧图标栏 + 组件列 + 主区），把 `AdminMenuWidget` 的占位符换成 7 个页签：

1. **概览** — 成员/角色/连接/库计数、最近被拒绝的访问（含"是不是该给他开权限"的暗示）、待处理（到期临时账号）。
2. **用户** — 列表（姓名/登录名/来源/角色/可访问连接与库数/状态/最近登录）；新增/编辑弹窗（登录名、来源、初始密码、角色多选、数据范围、有效期、状态）。
3. **角色与授权** — 左列表 + 右编辑器，6 个页签：
   - 基础：角色名、说明、功能权限 DSL（`admin/*`、`server-connections/*`、`run_script` …）
   - 连接：勾选连接（或"全部连接"）
   - 数据库：规则表 + "添加规则"（连接 × 按名称列表/正则/全部库 × 档位），带**命中预演**列（防止正则写错导致 0 个库）
   - 对象：只写例外，其余继承库档位
   - 细粒度/限制：操作开关（DDL/导出/备份/杀进程/多语句/插件）、最大行数、超时、允许时段、IP 白名单、行级过滤、列级脱敏
   - 成员：谁拥有这个角色
4. **访问矩阵** — 行 = 数据库（按连接分组），列 = 角色（可直接在下拉里改档位）/ 成员（只读，由角色并集实时算出）。这是"不同的人有不同的库"最直观的一屏。
5. **权限预览 / 模拟** — 选一个成员，看他能看到什么、哪些列被脱敏、哪些被拒绝、限制是什么。上线前用它验收。
6. **审计日志** — 时间/成员/类型/目标/语句/结果/耗时/IP；筛选"被拒绝/脱敏命中/权限变更"。
7. **认证方式** — 本地密码 / LDAP / OAuth2 / 环境变量用户（可一键导入）/ API Token。

另外两个刻意的交互：

- **右上角可切换登录身份**：切到王五（数据分析）后，左侧"数据库"树实时只剩 `order_db`、`user_db`、`analytics`、`usercenter`、埋点库，`pay_db` 消失，`customers.phone` 标上脱敏标记；"管理"图标变灰并挂锁（因为他没有 `admin/*`）。
- **没有 `admin/*` 时主区仍然显示那句 `Sorry, administration is not available`** —— 把现状和改造目标放在同一个画面里对照。

> 原型里的"保存"只写浏览器内存，不碰任何后端。

---

## 4. 实现落点：改哪些文件

### 4.1 不改什么（避免破坏现有实现）

- 不动权限字符串 DSL 与 `compilePermissions` / `testPermission` / `getPredefinedPermissions`（`packages/tools/src/testPermission.ts`）。
- 不动数据库/对象档位的枚举与继承规则（`hasPermission.js:170-324`）。
- 不动环境变量认证与 `PERMISSIONS` / `LOGIN_PERMISSIONS_<login>`：**没有任何配置文件时，行为与今天完全一致**。
- 不动 `packages/api/src/storageModel.js`（AGENTS 明确要求：由 `yarn storage-json` 从 table YAML 生成）。

### 4.2 新增 / 改动清单（建议）

| # | 文件 | 动作 | 说明 |
|---|---|---|---|
| 1 | `packages/api/src/auth/localAuthProvider.js` | 新增 | 文件存储版的 `AuthProvider`：实现 `getCurrentPermissions`、`checkCurrentConnectionPermission`、`getCurrentDatabasePermissions`、`getCurrentTablePermissions`、`getCurrentFilePermissions`、`login`。参照 `authProvider.js:39-57` 的接口 |
| 2 | `packages/api/src/controllers/permissions.js` | 新增 | 管理端 CRUD 路由（用户/角色/授权规则）。**新文件、新路由前缀**，每条路由用 `testStandardPermission('admin/users' \| 'admin/roles' \| 'admin/auditlog')` 把关（对齐 `storage.test.js:64-88` 已有的映射） |
| 3 | `packages/api/src/utility/hasPermission.js` | 小改（2 处） | 把 `process.env.STORAGE_DATABASE` 的短路条件替换为一个语义化判定 `isPermissionStoreActive()`（storage 数据库 **或** 本地权限存储已启用）。改动面越小越好，避免与 Premium 合并冲突 |
| 4 | `packages/api/src/auth/authProvider.js` | 小改 | `detectEnvAuthProviderCore`（`:305`）增加 `local` 分支：启用本地权限存储时返回 `local` |
| 5 | `packages/api/src/controllers/permissionsDb.js` | 新增 | 存储层，沿用 `JsonLinesDatabase`（`connections.js:182` 已经这么存 `~/.dbgate/connections.jsonl`）。建议 `~/.dbgate/roles.jsonl`、`~/.dbgate/users.jsonl`、`~/.dbgate/grants.jsonl` |
| 6 | `packages/web/src/tabs/AdminUsersTab.svelte` / `AdminRolesTab.svelte` / `AdminMatrixTab.svelte` / `AdminAuthTab.svelte` | 新增 | 管理界面。注意 `TabsPanel.svelte:202` 已经按 `tabComponent.startsWith('Admin')` 翻译成"Administration" |
| 7 | `packages/web/src/widgets/AdminMenuWidget.svelte` | 替换占位符 | 左侧"管理"入口列出上述页签，按 `hasPermission('admin/*')` 决定是否可见 |
| 8 | `packages/web/src/admin/FolderPermissionChooser.svelte` | 修复 | 补回缺失的 `PermissionCheckBox.svelte`（或删掉坏导入） |
| 9 | `translations/*.json` | 新增键 | 所有新文案走 `_t()`；按 AGENTS 约定，**新代码里的错误码一律 `DBGM-00000`** |

### 4.3 合并风险（必须提前说清楚）

本仓库是社区版，`../dbgate-pro` 会**整文件覆盖**同名路径，再合并成 `../dbgate-merged`。因此：

- `packages/api/src/controllers/storage.js`、`packages/api/src/auth/storageAuthProvider.js` 这类文件**不要动**（Premium 会覆盖，改了白改）。
- 社区实现应放在 **Premium 不会覆盖的新文件**里（上表的 #1、#2、#5、#6），对既有文件的改动收敛到 #3、#4 两处小改。
- 数据模型要与 `storageModel.js` 里的 `role_permissions` / `role_connections` / `role_databases` / `role_tables`（列名已核对：`database_names_list`、`database_names_regex`、`table_names_list`、`table_permission_role_id`、`table_permission_scope_id` …）**同名同义**，这样社区版的权限配置将来能直接导入 Team 版，反之亦然。

### 4.4 向后兼容

- 没有 `users.jsonl` / `roles.jsonl` 时：不启用本地权限存储，认证与授权路径与今天一模一样。
- 环境变量用户（`LOGIN`、`LOGIN_PASSWORD_*`）继续生效；支持"从环境变量导入成员"变成普通成员，**且导入后旧的 env 仍然有效**（幂等，不删除）。
- 现有 `PERMISSIONS` 串继续作为功能权限基线生效。

---

## 5. 执行计划

### P0 — 骨架打通（可演示：给成员开一个库）

- [ ] `localAuthProvider` + `permissionsDb`（JSON 存储，含 schema 版本号与迁移位）
- [ ] `permissions.js` 路由 + `admin/*` 权限把关 + 单测（参照 `storage.test.js` 的写法：每条路由断言"先要权限"）
- [ ] `hasPermission.js` 的两处短路改为 `isPermissionStoreActive()`
- [ ] 界面：用户列表/新增、角色列表、连接勾选、数据库规则（列表 + 正则 + 档位）
- [ ] 验收：新建用户 → 授一个库 → 用它登录 → 数据库树里只有那一个库，其它连接不可见

### P1 — 管理者可用（可上线给自己团队用）

- [ ] 访问矩阵（按角色可编辑 / 按成员只读）
- [ ] 权限预览/模拟 + "以该身份打开数据库"
- [ ] 对象级例外；操作开关（DDL/导出/备份/杀进程/多语句）
- [ ] 审计日志补齐"权限变更"事件与筛选
- [ ] 认证方式页：本地密码（bcrypt）+ 环境变量导入 + LDAP/OAuth 保留
- [ ] 临时账号有效期 + 到期回收提示

### P2 — 细粒度（需要单独评估，别与 P0/P1 混发）

- [ ] 列级脱敏（结果流 transform）
- [ ] 行级过滤（`sqltree` AST 注入；**同时强制关闭该库的 `run_script`**）
- [ ] 行数上限 / 超时 / 时段 / IP 白名单
- [ ] （可选）高风险操作审批流、临时授权（JIT）

### 测试策略

- 单测：权限解析（角色并集、deny 优先、规则顺序、正则命中）—— 这是最该被钉死的部分，原型已经用 19 条断言验证过同样的语义。
- 路由单测：每条管理端路由"必须索要 `admin/<x>`"，直接复用 `storage.test.js` 的模式。
- Cypress E2E：`e2e-tests`，选择器用 `data-testid="AdminUsersTab_newUserButton"` 这种格式（原型里已经按这个约定标好）。
- 回归红线：**没有权限存储文件时，行为必须与改造前逐字节一致**（新增一个"未启用"分支的测试）。

---

## 6. 风险与开放问题

| # | 问题 | 影响 | 我的建议 |
|---|---|---|---|
| 1 | **要不要加配置开关**（默认关闭=完全保持现状单管理员，开启才启用多用户/权限管理） | 影响部署升级路径与合并冲突面 | 见下方问题清单，需要你拍板 |
| 2 | Premium 合并会整文件覆盖同名路径 | 社区实现可能被覆盖 | 实现放在新文件；对既有文件只做最小改动（§4.3） |
| 3 | 行级过滤与 `run_script` 天然冲突 | 安全承诺可能落空 | P2 单独立项；UI 上强制联动关闭 `run_script` 并明确提示 |
| 4 | 社区版定位 | 会不会抢 Team Premium 的功能 | 需要你决定这个功能的边界（只做连接/库/对象，还是含行列级） |
| 5 | 权限引擎的 `all-databases` 短路 | 配错基线=全员全库 | §2.3，必须显式 `~all-databases` 并加测试 |

### 需要你拍板的三个问题

1. **开关**：默认关闭（`PERMISSION_STORE=off` 时与今天完全一致，开启后走新体系）还是默认开启？
2. **P0/P1 范围**：先只做"连接 → 库 → 对象"三级（复用已有引擎，风险低）？还是行级/列级一起做（需要 AST 改写，风险高）？
3. **成员凭据**：本地密码（bcrypt 存 `~/.dbgate/users.jsonl`）由本功能提供，还是成员只从已有 LDAP/OAuth/环境变量来、本功能只管授权？
