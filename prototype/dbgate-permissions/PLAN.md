# DbGate 团队权限管理 · 设计说明与研发计划 v0.1

> 配套可点原型：`prototype/dbgate-permissions/index.html`（纯静态单文件，无外部依赖）
> 本文所有结论都来自当前仓库代码，已标注文件与行号，便于逐条核对。

---

## 0. 一句话方案

**把"角色 → 连接 → 数据库 → 对象"三级授权做成管理界面，落在社区版自己的文件存储上，复用已有的权限引擎（`hasPermission.js` + `testPermission.ts`），不新建一套并行体系；成员登录走哆啦A梦（go-zoox/connect 网关）。行级/列级细粒度留下一期。**

成员用哆啦A梦登录、经网关注入的 `X-Connect-Token` 进入，不再共用数据库密码；管理员在网页上按岗位配角色，默认拒绝、按需开库；成员只看到自己有权限的连接与库。

---

## 1. 现状：读完代码后的结论

### 1.1 认证：社区版其实是"多登录名 + 单管理员"，但没有用户对象

- 认证方式由环境变量决定：`LOGIN`/`PASSWORD`、`LOGIN_PASSWORD_<login>`、`AD_*`、`OAUTH_*`，见 `packages/api/src/auth/authProvider.js:305-320`（`detectEnvAuthProviderCore`）。**没有哆啦A梦 / connect 网关适配**（§2.4）。
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

### 2.4 登录：哆啦A梦 + go-zoox/connect 网关（已定）

DbGate 本身没有哆啦A梦登录适配（找过了：`doreamon-design/dbgate` 只有 `master`，本地 checkout 也只有 `master`）。但你有现成的一族适配分支可以照抄：

| 仓库 | 分支 | 集成方式 |
|---|---|---|
| `doreamon-design/uptime-kuma` | `feat/support-zoox-connect` | **Node.js 应用挂 connect 网关**（与 DbGate 技术栈最接近） |
| `doreamon-design/memos` | `feat/add-connect` | 挂 connect 网关 |
| `doreamon-design/open-cdm` | `feat/support-connect-gateway` | 挂 connect 网关 |
| `doreamon-design/gogs` | `feat/support-oauth2` | 应用内做 OAuth2 客户端 |
| `doreamon-design/memos_old_using_oauth2_client` | `feat/add-oauth2-doreamon-support` | 应用内做 OAuth2 客户端 |

推荐走**网关模式**（DbGate 是 Node/Express + Svelte 单体，SPA 与 `/api` 同源，网关单上游转发最省事），契约如下（已核对本机 `go-zoox/connect` v1.20.1）：

```
浏览器 → connect 网关（whatwewant/connect-doreamon:v1，`connect doreamon`）
        → 哆啦A梦 OAuth2（api.zcorky.com/oauth/app，CLIENT_ID/CLIENT_SECRET/REDIRECT_URI）
        → 注入请求头 X-Connect-Token（JWT，HS256，SESSION_KEY 签名）
        → DbGate API：校验 token → 还原当前用户 → 按角色授权
```

`X-Connect-Token` 的 claims（`user/user.go` 的 `Encode/Decode`）：
`id` / `nickname` / `avatar` / `email` / `username` / `feishu_open_id` / **`permissions[]`**。

落到 DbGate 的具体改动：

1. `packages/api/src/controllers/auth.js` 的 `authMiddleware`（`:103`）**最前面**加一段：读 `X-Connect-Token`（header → query `X-Connect-Token` → query `access_token`），用 `SESSION_KEY`（别名 `SECRET_KEY`）`jwt.verify` 校验，成功则 `req.user = { login: username||email, userId: id, nickname, email, avatar, amoid: 'connect' }` 并 `next()`。
2. 新增 `packages/api/src/auth/connectAuthProvider.js`：`amoid='connect'`、`workflowType='redirect'`（`LoginPage.svelte:57` 已支持 redirect 流程，前端只会显示一个跳转按钮，不再出现本地密码表单）。
3. `detectEnvAuthProviderCore`（`authProvider.js:305`）增加 `connect` 分支（`CONNECT_AUTH=1` 或存在 `SESSION_KEY` 时命中）。
4. `getCurrentPermissions(req)` 返回**本地角色**算出的权限串，而不是原样透传哆啦A梦的 `permissions`；`permissions` claim 只用于**角色映射**（见下）。
5. 成员自动建档：以 `email` 为唯一键 upsert 本地成员，默认角色 = 「待分配」（零库权限）。

**两条必须守住的安全线：**

- **`permissions` 为空 = 拒绝，不是放行。** connect 在权限查询失败时会把 `permissions` 留空，并在 `app/router/router.go:392` 的注释里明确要求上游按 deny-by-default 处理。而 DbGate 现有 `hasPermission()` 在权限为 `null`/空时是 **放行**（`hasPermission.js:18-21`，fail-open）。适配层必须把「空」翻译成一个显式的拒绝基线，**绝不能返回 `null`**。
- **DbGate 端口不要对公网暴露。** 网关靠注入 header 传递身份，任何能直连 DbGate 的人都能自己构造这个 header（伪造签名需要 `SESSION_KEY`，但没必要给机会）。容器里只 `expose`，不 `publish`。

另外，`permissions` claim 的注入需要 connect 镜像 ≥ v1.20.0（本机 checkout 是 v1.20.1，含 `fillPermissions` 与失败不缓存/去掉请求路径 sleep 的修复）；旧镜像（如 `registry.ys.zcorky.com/whatwewant/connect-doreamon:v1` 的 2026-02-15 构建）没有这个符号，必须先重建，否则所有成员的 `permissions` 都是空。

### 2.4.1 `SUPER_ADMIN` → 自动成为超级管理员（已定）

**规则**：token 校验通过后，若 `permissions` **精确包含** `SUPER_ADMIN`，则把该成员自动设为 DbGate 的超级管理员（等价于内置身份 `{ login:'superadmin', roleId:-3, amoid:'superadmin' }`，见 `controllers/auth.js:222-235`），拥有全部连接、全部数据库与全部管理功能。**每次登录都执行（幂等）**，并写审计日志。

**为什么用内置角色而不是"给个 `*` 权限的角色"**：`roleId = -3` / `amoid = 'superadmin'` 是这套代码里既有的"超级管理员"语义，storage 版与 MCP 的既有判断（`storage.test.js:192`）都认它；自己造一个 `['*']` 角色会在 Premium 合并后出现两套超管概念。

四种情况的确定语义（原型「登录 / 成员来源」页可逐条模拟）：

| 场景 | `permissions` | 结果 |
|---|---|---|
| 首次登录，带 `SUPER_ADMIN` | `['SUPER_ADMIN']` | 建档 + 自动授予超级管理员 + 审计 |
| 已是成员，本次仍带 | `['SUPER_ADMIN', …]` | **幂等**：不重复授权，仅刷新昵称/邮箱/最近登录 |
| 已有成员，本次不再带 | `['USER_PERMISSION']` | **自动降级**：只摘掉「来源 = doreamon」的那一份超级管理员，回落到映射角色；**本地手工授予的兜底管理员不动** |
| 权限查询失败 | `[]` 或缺失 | **不判定**：该请求按拒绝处理（403），但**不改成员角色** —— 查询失败 ≠ 权限被收回 |

**两个实现要点（必须写进代码注释和测试）：**

1. **区分来源**：成员上存 `superAdminSource: 'doreamon' | 'local' | null`。自动降级**只能**删除 `'doreamon'` 的那一份；`'local'` 是兜底账号，永远不动。
2. **必须有兜底**：如果哆啦A梦把所有 `SUPER_ADMIN` 都撤了，本地还要留一个能进管理界面的超级管理员（`ADMIN_PASSWORD` 应急入口，或首次启动迁移出来的本地超管）。否则会全员锁死，没人能改回来。
3. **空 = 不判定**，不是"没有权限"：这与 §2.4 的 deny-by-default 不矛盾 —— 空 `permissions` 让**本次请求**被拒绝（授权层面 fail-closed），但**不产生持久化的降级副作用**（状态层面不去动）。

**代码落点**：`connectAuthProvider` 里 token 解码成功后的 `ensureConnectMember(user)`（§4.2 #1）；判定函数独立且纯（`permissions: string[] → 'elevate' | 'revoke' | 'skip'`），便于单测覆盖上表四种情况。

### 2.5 细粒度的实现边界（别在原型上过度承诺）

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
7. **登录 / 成员来源** — 哆啦A梦登录链路（connect 网关 + `X-Connect-Token`）、角色映射规则、成员自动建档与同步；API Token；环境变量用户（兼容）。

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
| 1 | `packages/api/src/auth/connectAuthProvider.js` | 新增 | 哆啦A梦 + connect 网关的 `AuthProvider`（`amoid='connect'`、`workflowType='redirect'`）：实现 `getCurrentPermissions`、`checkCurrentConnectionPermission`、`getCurrentDatabasePermissions`、`getCurrentTablePermissions`、`getCurrentFilePermissions`、`login`。参照 `authProvider.js:39-57` 的接口 |
| 2 | `packages/api/src/controllers/permissions.js` | 新增 | 管理端 CRUD 路由（用户/角色/授权规则）。**新文件、新路由前缀**，每条路由用 `testStandardPermission('admin/users' \| 'admin/roles' \| 'admin/auditlog')` 把关（对齐 `storage.test.js:64-88` 已有的映射） |
| 3 | `packages/api/src/utility/hasPermission.js` | 小改（2 处） | 把 `process.env.STORAGE_DATABASE` 的短路条件替换为一个语义化判定 `isPermissionStoreActive()`（storage 数据库 **或** 本地权限存储已启用）。改动面越小越好，避免与 Premium 合并冲突 |
| 4 | `packages/api/src/auth/authProvider.js` + `packages/api/src/controllers/auth.js` | 小改 | `detectEnvAuthProviderCore`（`:305`）增加 `connect` 分支；`authMiddleware`（`auth.js:103`）最前面加 `X-Connect-Token` 校验（见 §2.4） |
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

### 4.4 向后兼容（默认开启的前提下）

- **首次启动迁移**：权限存储为空时，把既有的 `ADMIN_PASSWORD`（或首个 `LOGIN` 用户）建成一个 `platform-admin` 成员，并写入 `permissionsDb`；此后不再依赖环境变量也能管理。
- 环境变量用户（`LOGIN`、`LOGIN_PASSWORD_*`）继续生效；支持"从环境变量导入成员"变成普通成员，**且导入后旧的 env 仍然有效**（幂等，不删除）。
- 现有 `PERMISSIONS` 串继续作为功能权限基线生效；未被任何本地成员/角色命中的请求，行为与今天一致。
- 数据库/对象级的**默认值**保持今天的语义：连接未授权 → 不可见；库未命中规则 → 无权限。
- 回归测试红线：升级前后，同一组环境变量下的**既有连接访问结果**必须逐条一致。

---

## 5. 执行计划

### P0 — 骨架打通（可演示：哆啦A梦登录进来的成员被正确授权）

- [ ] `connectAuthProvider` + `authMiddleware` 的 `X-Connect-Token` 校验（§2.4；含「permissions 为空 = deny」的测试）
- [ ] `SUPER_ADMIN` 自动提权/降级（§2.4.1）：判定函数纯化 + 四种情况单测 + 只在 `superAdminSource==='doreamon'` 时降级 + 本地兜底管理员不被动
- [ ] `permissionsDb`（JSON 存储，含 schema 版本号与迁移位）+ 成员自动建档（`email` 唯一键，默认角色「待分配」）
- [ ] `permissions.js` 路由 + `admin/*` 权限把关 + 单测（参照 `storage.test.js` 的写法：每条路由断言"先要权限"）
- [ ] `hasPermission.js` 的两处短路改为「是否有权限存储」判定
- [ ] 界面：用户列表、角色列表、连接勾选、数据库规则（列表 + 正则 + 档位）
- [ ] 老用户升级路径：既有 `ADMIN_PASSWORD` / `PERMISSIONS` / `LOGIN_PASSWORD_*` 仍然生效，并在用户页可见
- [ ] 验收：哆啦A梦账号登录 → 自动建档 → 授一个库 → 数据库树里只有那一个库，其它连接不可见

### P1 — 管理者可用（可上线给自己团队用）

- [ ] 访问矩阵（按角色可编辑 / 按成员只读）
- [ ] 权限预览/模拟 + "以该身份打开数据库"
- [ ] 对象级例外；操作开关（DDL/导出/备份/杀进程/多语句）
- [ ] 审计日志补齐"权限变更"事件与筛选
- [ ] 登录/成员来源页：connect 网关配置向导 + 角色映射规则 + 从哆啦A梦同步成员 + 环境变量导入
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
- 回归红线：**升级前后，同一组环境变量 / 同一批连接下的访问结果必须逐条一致**（固定一组 env 跑前后对比）。

---

## 6. 风险与开放问题

| # | 问题 | 影响 | 我的建议 |
|---|---|---|---|
| 1 | **默认开启**（已定） | 升级路径必须一次性给全，否则老部署装不上 | P0 里做首次启动迁移（§4.4），并留回归红线 |
| 2 | Premium 合并会整文件覆盖同名路径 | 社区实现可能被覆盖 | 实现放在新文件；对既有文件只做最小改动（§4.3） |
| 3 | 行级过滤与 `run_script` 天然冲突 | 安全承诺可能落空 | P2 单独立项；UI 上强制联动关闭 `run_script` 并明确提示 |
| 4 | connect 网关的 `permissions` 空值 | 角色映射失效，或被误判为放行 | §2.4：空 = deny；先确认镜像版本 |
| 6 | `SUPER_ADMIN` 自动提权被滥用 | 任何拿到该权限的账号都会成为超管 | §2.4.1：只认精确匹配 + 每次登录重算 + 全量审计；权限本身仍由哆啦A梦治理 |
| 5 | 权限引擎的 `all-databases` 短路 | 配错基线=全员全库 | §2.3，必须显式 `~all-databases` 并加测试 |

### 已定的三件事（2026-10-14 确认）

1. **不加开关，默认开启**：装上就是多用户权限管理。→ 影响：P0 必须同时给出「单管理员老用户」的升级路径（首次启动把既有 `ADMIN_PASSWORD` 建成一个 `platform-admin` 成员；`PERMISSIONS` / `LOGIN_PASSWORD_*` 继续生效，不删不覆盖）。
2. **v1 只做三级**：连接 → 库 → 对象，完全复用已有权限引擎；行级/列级进 P2。
3. **成员用哆啦A梦登录**：go-zoox/connect 网关 + `X-Connect-Token`，DbGate 不保存成员密码；本地成员由 `email` 自动建档，角色在管理界面配（可选按 `permissions` claim 映射，见 §2.4）。

### 仍然需要留意的开放项

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| A | connect 网关镜像版本 | 旧镜像的 token 里没有 `permissions` claim，角色映射失效 | 先确认/重建 `connect-doreamon`（≥ v1.20.0） |
| B | 成员唯一键 | 有人改邮箱会导致重复建档 | 用 `id` 作内部主键、`email` 作匹配键，两者都存 |
| C | 默认角色 | 新成员自动进来时权限过大很危险 | 默认「待分配」= 零库权限，等管理员分配 |
| D | 网关不可用时的降级 | 全员无法登录 | connect 与 DbGate 都配健康检查；**不要**在 DbGate 侧回落到「无认证」 |
