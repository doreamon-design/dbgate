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

### P0 — 骨架打通（可演示：哆啦A梦登录进来的成员被正确授权）✅ 2026-10-14 完成

- [x] `connectAuthProvider` + `authMiddleware` 的 `X-Connect-Token` 校验（§2.4；含「permissions 为空 = deny」的测试）
- [x] `SUPER_ADMIN` 自动提权/降级（§2.4.1）：判定函数纯化 + 四种情况单测 + 只在 `superAdminSource==='doreamon'` 时降级 + 本地兜底管理员不被动
- [x] 权限存储（JSON，含 schema 版本号）+ 成员自动建档（`email`/`connectUserId` 匹配，默认角色「待分配」）
- [x] `permissions.js` 路由 + `admin/*` 权限把关 + 单测（参照 `storage.test.js` 的写法：每条路由断言"先要权限"）
- [x] `hasPermission.js` 的两处短路改为「是否有权限存储」判定（另加 5 处列表过滤/服务端 chat 的同类短路）
- [x] 界面：用户列表/编辑、角色列表/编辑、连接勾选、数据库规则（名称列表 + 档位）
- [x] 老用户升级路径：既有 `ADMIN_PASSWORD` / `PERMISSIONS` / `LOGIN_PASSWORD_*` 仍然生效，并在用户页可见
- [ ] 验收跑通"哆啦A梦账号登录 → 授权 → 只见一个库"的 **UI 端到端**（后端链路已跑通，见 §7；只差真库环境）

### P1 — 管理者可用（可上线给自己团队用）

- [x] 访问矩阵（按角色可编辑 / 按成员只读 + 对象级下钻）—— 见 §8.11，已在真实 SQLite 库上验收
- [x] 权限预览 / 模拟：`get-user-access`（规则 + 来源角色 + 档位名）与 `resolve-access`（解析某个具体连接/库/表）＋ `AdminAccessPreviewTab.svelte`
- [x] 对象级例外：`saveRoleTable` 链路打通 + 角色页新增「对象例外」表格（连接 / 库 / 范围 / 对象名 / 对象档位）
- [x] 操作开关（执行查询/导出/导入/服务端 chat/Shell 脚本/归档写/插件安装/插件命令/应用编辑/改设置/读应用日志）—— 见 §8.7，含「每个开关必须有真实强制点」的守卫测试
- [x] 临时账号有效期：`expires` 落库 + 到期即 deny-all（含 UI 输入框与列表标记）
- [x] 权限变更审计事件：写入 `sendToAuditLog`（社区版是空实现，接 Premium 后自动出现在审计日志里）
- [x] 登录 / 成员来源页：connect 状态、SUPER_ADMIN 规则说明、成员来源分布、环境变量导入

### P2 — 细粒度（需要单独评估，别与 P0/P1 混发）

- [~] 列级脱敏：网格结果路径已完成（§8.12）；**流式导出路径待接**，当前对配了脱敏的角色直接拒绝批量导出
- [x] 行级过滤：结构化规则注入结构化 select（§8.13），并已实现与 `run_script` 的**硬互斥**
- [x] 行数上限 / 超时 / 时段 / IP 白名单（§8.16，含真库验收）
- [ ] （可选）高风险操作审批流、临时授权（JIT）

### 测试策略

- 单测：权限解析（角色并集、deny 优先、规则顺序、正则命中）—— 这是最该被钉死的部分，原型已经用 19 条断言验证过同样的语义。
- 路由单测：每条管理端路由"必须索要 `admin/<x>`"，**参照** `storage.test.js` 的 `ADMIN_ROUTES` 写法，但不能直接复用该文件（见下）。
- Cypress E2E：`e2e-tests`，选择器用 `data-testid="AdminUsersTab_newUserButton"` 这种格式（原型里已经按这个约定标好）。
- 回归红线：**升级前后，同一组环境变量 / 同一批连接下的访问结果必须逐条一致**（固定一组 env 跑前后对比）。

#### 已实测的基线（2026-10-14，`yarn install` 之后，Node 24.21.0）

| 套件 | 命令 | 结果 |
|---|---|---|
| `packages/tools` | `yarn workspace dbgate-tools test` | ✅ 4 suites / 42 tests |
| `packages/datalib` | `yarn workspace dbgate-datalib test` | ✅ 3 suites / 21 tests |
| `packages/filterparser` | `yarn workspace dbgate-filterparser test` | ✅ 1 suite / 1 test |
| `plugins/dbgate-plugin-mongo` | `cd plugins/dbgate-plugin-mongo && yarn test` | ✅ 1 suite / 18 tests |
| `packages/api` | `cd packages/api && yarn test` | ⚠️ 16/20 suites、270 tests 通过；**4 个 suite 加载失败**（见下） |

**4 个加载失败的 suite（既有问题，改造前就红，与本次工作无关）**：

```
src/controllers/storage.test.js         Cannot find module './storageDb'
src/controllers/teamFiles.test.js       Cannot find module './storageDb'
src/controllers/teamFilesExport.test.js Cannot find module './storageDb'
src/auth/authProvider.test.js           Cannot find module '../controllers/storageDb'
```

`storageDb.js` 是 Premium 侧模块，社区版仓库里不存在（`storage.js` 只有桩函数），这 4 个测试文件是随合并同步进来的、只能在 merged/Premium 仓跑。**影响**：① 这 4 个文件不能作为 P0 的测试基线，新测试必须自带 mock，不得 `require('./storageDb')`；② `storage.test.js` 恰好是"管理端路由 × 所需权限"的对照表，P0 要把它抄成不依赖 Premium 的版本。

未跑：`integration-tests`（CI 里需要 postgres/mysql/mssql/clickhouse 容器）、`e2e-tests`（不是 workspace，需另行 `yarn install` + Cypress 浏览器 + 起服务）。

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

---

## 7. P0 实现记录（2026-10-14）

### 7.1 落地清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `packages/api/src/utility/permissionLevels.js` | 新增 | 档位 ↔ storageModel 数字 id 的双向映射（`-1..-5` / `-1..-9`），hasPermission 与存储共用一份 |
| `packages/api/src/utility/permissionStore.js` | 新增 | 同步 JSON 存储（`<datadir>/permissions.json`）：内置角色、引导、成员建档、`SUPER_ADMIN` 规则、权限串拼装 |
| `packages/api/src/auth/connectAuthProvider.js` | 新增 | `X-Connect-Token` 校验 + 身份落地；`createConnectAuthProvider(AuthProviderBase)` 工厂（避开循环依赖） |
| `packages/api/src/controllers/permissions.js` | 新增 | 16 条管理端路由，全部 `admin/users` / `admin/roles` 把关；新增 `_init()` 做引导 |
| `packages/api/src/utility/hasPermission.js` | 改 | 两处 `STORAGE_DATABASE` 短路 → `isPermissionStoreActive()`；三张映射表改为从 permissionLevels 引入 |
| `packages/api/src/controllers/serverConnections.js` / `databaseConnections.js` | 改 | 5 处列表过滤 / 服务端 chat 的同类短路改用 `isPermissionStoreActive()` |
| `packages/api/src/auth/authProvider.js` | 改 | 文件末尾注册 connect provider；`getAuthProviderFromReq` 在有成员时把授权绑定到存储 |
| `packages/api/src/controllers/auth.js` | 改 | `authMiddleware` 最前面处理 `X-Connect-Token`（校验失败一律 401，不静默降级） |
| `packages/api/src/main.js` | 改 | 注册 `/permissions` 控制器 |
| `packages/web/src/tabs/AdminUsersTab.svelte` / `AdminRolesTab.svelte` | 新增 | 成员管理、角色与授权（连接勾选 + 数据库规则） |
| `packages/web/src/widgets/AdminMenuWidget.svelte` | 改 | 占位符 → 真实管理菜单（按 `admin/*` 权限显隐），入口在这 |
| `packages/web/src/tabs/index.js` | 改 | 注册两个 `Admin*Tab` |

**前端入口**：左侧图标栏「管理」（`widgets/admin` 权限）→ `AdminMenuWidget` → 点「成员 / 角色与权限」打开对应标签页（`Admin*Tab` 会被 `TabsPanel` 归到 "Administration" 分组）。

### 7.2 与计划的偏差（都是实现时发现的真问题）

1. **基线的 deny 清单比计划多**。计划只写了 `~all-databases` / `~all-connections`，实际必须再加 `~all-tables`、`~all-disk-files`、`~connections/*`。原因：基线的 `*` 会让**所有**白名单短路判定为真 —— 单测里"受限角色仍能访问未授权连接"就是这么暴露出来的。
2. **存储是一个文件而不是三个 jsonl**。引导必须在 `useController._init()` 同步完成，写用临时文件 + rename 原子替换；三个 jsonl 反而要多做一致性处理。
3. **`getAuthProviderFromReq` 需要把授权绑定到存储**。否则界面里配的角色只对网关登录生效，环境变量登录的老用户仍然走 `PERMISSIONS`。现在的规则是：能解析到成员就切到存储 provider，解析不到（匿名/未入库）保持原行为。
4. **`CONNECT_AUTH` 是显式开关**。`SECRET_KEY`/`SESSION_KEY` 名字太通用，拿它当触发器会让"本来没打算接网关"的部署突然全 401；密钥仍从 `SESSION_KEY`（或 `SECRET_KEY`）读。
5. **引导时要补一个 `superadmin` 成员**（仅当设了 `ADMIN_PASSWORD`）。管理员密码登录签发的是 `login:'superadmin'`，存储里没有对应成员的话，一旦存储成为授权来源，这条路会被判成"查不到成员 → 全拒绝"。
6. **空 permissions 的语义要分两层**：授权层 fail-closed（该请求 401/403），状态层不动成员角色。单测与线上实测都覆盖了。

### 7.3 验证结果

**单元 + 集成（`cd packages/api && npx jest`）**：20 个 suite 通过 / 24 个，**366 tests 全绿**（改造前基线：16 / 20、270 tests；4 个失败 suite 是既有的 Premium `storageDb` 缺模块问题）。

新增 4 个测试文件、96 条用例：`permissionStore.test.js`(16)、`connectAuthProvider.test.js`(18)、`permissions.test.js`(55)、`hasPermission.test.js`(7)。

其中 `hasPermission.test.js` 是接线测试，钉住两个方向：
- 存储不存在 → 行为与改造前逐条一致（数据库档位检查直接跳过）；
- 存储存在 → 未授权连接抛 `DBGM-00263/00264`、越档位抛 `DBGM-00266`、未配规则的库默认拒绝、停用成员全拒、未知成员 **fail-closed 而不是 fail-open**。

**真实启动的端到端**（`WORKSPACE_DIR=/tmp/dbgate-smoke CONNECT_AUTH=1 SESSION_KEY=… node src/index.js --listen-api`）：

| 请求 | 结果 |
|---|---|
| 启动后自动引导 | `permissions.json` 生成，3 个内置角色 + 本地管理员（`superAdminSource: local`） |
| 无 token 调 `permissions/get-summary` | `401 missing authorization header` |
| 伪造签名 token | `401 connect token rejected: invalid signature` |
| 普通 permissions token | `500 DBGM-00265 Permission admin/users not granted` |
| 空 permissions token | 同上（未提权） |
| `SUPER_ADMIN` token | `200` + 存储概览；成员自动建档为 `roles: unassigned,superadmin`、`source: doreamon` |
| 再发一次同 token | 幂等，无变化（`changed=false`，不重复落盘） |
| 同一用户改发不含 `SUPER_ADMIN` | 自动降级：摘掉 superadmin、`source` 清空、保留 `unassigned` |
| 空 permissions 再发一次 | 无变化（不判定） |
| 全程 | 本地兜底管理员 `admin` 的 `local` 来源始终未被触碰 |

### 7.4 P0 未完成 / 已知限制

- **UI 端到端未跑**：本机没有 docker，起不了真库；"授权后数据库树只剩一个库"目前由后端集成测试覆盖（`serverConnections.listDatabases` 的过滤路径），UI 层待有真库环境时验收。
- `svelte-check`（`yarn workspace dbgate-web validate`）在 Node 24 下崩溃（`svelte-check` 内置的旧 typescript 不兼容），CI 用 Node 22 正常；本次以人工核对 + 后端测试为准。
- `yarn ts`（API）在 `node_modules/zod/v4/*.d.cts` 报大量解析错误（仓库 TS 版本与 zod v4 声明文件不匹配，既有问题），**`src/` 下零错误**。
- 对象级例外（`role_tables`）后端已打通并有测试，UI 还没做（P1）。

---

## 8. P1 实现记录（第 1 批，2026-10-14）

### 8.1 做了什么

| 能力 | 落点 |
|---|---|
| 临时账号有效期 | `permissionStore.isUserExpired` / `isUserDenied`；`buildUserPermissions`、`getUserDatabasePermissions`、`getUserTablePermissions`、provider 的 `checkCurrentConnectionPermission` 全部改走 `isUserDenied`；UI 增加「有效期至」输入与列表标记 |
| 有效权限预览 | `resolveUserAccess(user, {conid, database, table, objectTypeField, schema})` + `getUserAccessRules(user)`；路由 `get-user-access` / `resolve-access`（都索要 `admin/users`）；UI 新增 `AdminAccessPreviewTab.svelte` |
| 对象级例外 | 角色页新增「对象例外」表格（连接 / 库 / 范围 / 对象名 / 对象档位），保存走已有的 `save-role-detail.tables` |
| 权限变更审计 | 各变更路由调用 `sendToAuditLog`（`category: 'permissions'`，含 `user.save` / `role.save` / `grant.database` / `grant.connections` 等事件名） |

**预览不重新实现一套解析**：`resolveUserAccess` 直接懒加载 `hasPermission.js` 里已导出的 `getDatabasePermissionRole` / `getTablePermissionRole`（懒加载是为了避开 `permissionStore → hasPermission → authProvider → permissionStore` 的循环依赖）。有一条专门的测试拿同一批数据比对「预览结果 == 引擎结果」，防止两边漂移。

### 8.2 修掉的真 bug

- **`normalizeUser` 丢字段**：`expires` 没有进白名单，导致界面上填的有效期保存后立刻消失、到期判定永远为假。已修 + 加测试。
- **`getUserAccessRules` 少 import**：用了 `DATABASE_ROLE_ID_NAMES` 等三张反向映射表却没引入（`permissionLevels` 只导入了 `*_NAME_IDS`）。
- **测试里的全量 mock 打掉了真实依赖**：`permissions.test.js` 原来只 mock 了 `testStandardPermission`，而预览要复用真实解析器 → 改成 `...jest.requireActual(...)` 部分 mock。这个坑值得记住：**部分 mock 比全量 mock 安全**。

### 8.3 验证

- `packages/api`：**20/24 suite、381 tests 全绿**（P0 时 366；4 个失败 suite 仍是既有的 Premium `storageDb` 缺模块问题）。
- 新增用例：有效期 3 条、预览与引擎一致性 4 条、路由解析 3 条。
- 前端：`svelte-check` 在 Node 24 下崩溃，改用 `svelte.preprocess + svelte.compile` 逐个编译 4 个组件，**零错误、零 a11y/CSS 警告**。
- 真实启动验证新路由：`get-user-list` / `get-connection-list`（未配连接时返回空数组而不是报错）/ `get-options` / `get-user-access` / `resolve-access` 全部按预期返回；把某成员的有效期改成 `2000-01-01` 后，**该成员的下一个请求立刻被拒**，存储里 `isUserExpired=true`、权限串退化成 `["~*"]`、连接与库全部不可达，而本地兜底管理员不受影响。

### 8.4 这一批没做

- **访问矩阵**：行必须是真实数据库清单，得有可连的库才能成行 —— 留到有真库环境时做（`resolve-access` 已经提供了它需要的单格解析能力）。
- 操作开关 UI、登录/成员来源页、以某成员身份打开数据库（impersonation）。
- 对象级规则的「命中预演」列（原型里有）。

### 8.5 P1 第 2 批（2026-10-14）

- **环境变量成员导入**（`import-env-users`，索要 `admin/users`）：引导只在首次启动跑一次，之后往 env 里加人不会出现在列表里；这个路由把新登录补成成员并给「升级前兼容」角色。**幂等**，且不覆盖界面上改过的角色（有测试钉住）。
- **`get-summary` 增加 `connectAuth` 状态**：`enabled` / `hasSecret` / `logoutUrl`，让「登录 / 成员来源」页显示真实状态而不是写死的说明。
- **`AdminAuthTab.svelte`**：显示 connect 网关开关与密钥是否就位、`SUPER_ADMIN → superadmin` 规则的完整语义（含「空 permissions 不判定」「本地兜底不降级」）、成员来源分布、环境变量导入按钮、权限存储文件与 schema 版本。
- `AdminMenuWidget` 增加「登录 / 成员来源」入口。

真实启动验证：`get-summary` 返回 `connectAuth{enabled:true,hasSecret:true}`；引导阶段自动导入 env 登录 `latecomer`；再次调用 `import-env-users` 返回 `{imported:[], skipped:["latecomer"]}`（幂等）。

`packages/api`：**386 tests 全绿**（20/24 suite；4 个失败 suite 仍为既有的 Premium `storageDb` 缺模块）。5 个 Svelte 组件编译通过，零错误零 a11y 警告。

### 8.6 P1 剩余

- **访问矩阵**：需要真实数据库清单（要能连上库），`resolve-access` 已提供单格解析能力，等真库环境。
- 操作开关 UI（DDL / 导出 / 备份 / 杀进程 / 多语句）：后端权限点已存在，UI 未做。
- 以某成员身份打开数据库（impersonation）。
- 对象级规则的「命中预演」列（原型里有）。

### 8.7 P1 第 3 批：操作开关（操作级权限）

- **`utility/operationPermissions.js`**：11 个开关的白名单 —— 执行查询 `dbops/query`、导出 `dbops/sql-dump/export`、导入 `dbops/sql-dump/import`、服务端 chat `dbops/chat`、Shell 脚本 `run-shell-script`、归档写 `archive/write`、插件安装 `plugins/install`、插件命令 `plugins/command`、应用编辑 `apps/write`、改设置 `settings/change`、读应用日志 `application-log`。
- **开关语义**：基线是「默认允许 + `*`」，所以**关闭 = 往角色权限里加一条 `~<permission>`，开启 = 删掉它**。不需要堆 allow。
- **`operationPermissions.test.js` 是守卫测试**：扫 `packages/api/src`（排除测试文件），断言清单里每个 permission 都能匹配到一处真实的 `hasPermission('<perm>'` / `testStandardPermission('<perm>'` 调用。**没有强制点就不许加开关**。

  > 这条守卫的存在原因：仓库里有一批"看起来像权限"的字符串（`connections/save`、`server-connections/drop-database`、`plugins/install` 之外的一大串 `*_meta` 声明），在社区版里其实**没有任何强制点**（`useController` 的字符串 meta 分支是注释掉的）。照着它们做开关，界面上就会出现按了没反应的假开关。

- **UI**：角色页新增「操作」一栏，每个开关显示人类可读名称 + 实际权限串；内置角色禁用（其权限由代码固定）。

验证：`packages/api` **21/25 suite、403 tests 全绿**（本轮 386 → 403；4 个失败 suite 仍是既有的 Premium `storageDb` 缺模块）。新增守卫测试 14 条 + 开关行为 2 条（"关掉 `dbops/query` 后确实被拒，但 `dbops/sql-dump/export` 仍可用"）。

### 8.8 P2 可行性结论（本轮实地确认）

**列级脱敏不能当作小改动来做**：查询是在**子进程**里跑的（`proc/sessionProcess.js`、`proc/databaseConnectionProcess.js` 调用 `utility/handleQueryStream`），请求上下文（当前成员、角色脱敏规则）在那边拿不到，要把用户身份穿过进程参数传下去，再在 `StreamHandler` 的结果管线上挂一层 transform。这属于 `PLAN §2.5` 说的"P2 单独立项"，不该和 P1 混发。

**行级过滤**同样：要靠 `packages/sqltree` 改写语句，且与 `run_script` 天然冲突（成员能执行任意 SQL 就绕过了）—— 需要先决定"配了行级过滤的库是否强制关闭执行脚本"。

结论：P2 开工前需要先拍板两件事 —— ① 是否接受把当前用户身份传入子进程（涉及进程边界，改动面比 P0/P1 大）；② 行级过滤与 `run_script` 的互斥是否强制。

### 8.9 P1 第 4 批：真实数据库上的端到端验收（本轮最重要的产出）

用户选择了"本机起个测试库"。本机没有 docker、也没有任何数据库二进制，于是用 **SQLite**（`dbgate-plugin-sqlite` + 本地装 `better-sqlite3`，不动清单）搭真实库。

脚本：`packages/api/scripts/e2e-permissions.js`，`yarn workspace dbgate-api test:e2e:permissions`。
它自带数据（用 `run-script` 建表），只需一个跑着的 API。

**跑法**（`DEVMODE=1` 必需，否则插件后端解析不到 `src/backend/index.js`）：

```sh
cd plugins/dbgate-plugin-sqlite && npm install --no-save better-sqlite3   # 驱动，仅本地
cd packages/api
DEVMODE=1 WORKSPACE_DIR=/tmp/dbgate-e2e/ws CONNECT_AUTH=1 SESSION_KEY=<secret> node src/index.js --listen-api
SESSION_KEY=<secret> node scripts/e2e-permissions.js
```

**结果（11/11 全过）**：

| 断言 | 结果 |
|---|---|
| 保存连接 | ✅ |
| 全权成员能看到自己的连接 | ✅ |
| 全权成员能看到全部表 | ✅ customers / orders / payments |
| 受限角色 / 成员创建 | ✅ |
| 受限成员能看到被授权的连接 | ✅ 只看到被授的那一个 |
| **受限成员看不到被拒绝的表** | ✅ 只看到 customers / orders（`payments` 被对象规则拒绝） |
| 预览与真实结果一致 | ✅ orders=read（继承库级）、payments=deny（对象规则）、customers=create_update_delete（加宽） |

**这就是 P0 那条没做完的验收**："授权后数据库树里只有该看到的表" —— 现在用真库 + 真实 HTTP 链路证完了，而且是在**对象级**（表级）粒度上。

#### 顺手抓到的真 bug（已修 + 回归测试）

**`all-connections` 没有让 `connections/<conid>` 通过 → 连接列表为空。**
`connections/list` 是用 `connectionHasPermission()` 过滤的，它走的是 `connections/<conid>` 字符串，而 `all-connections` 只是 `testConnectionPermission` 里的一个短路标记。我原来在 `buildUserPermissions` 里只 push 了 `all-connections`，结果**连超级管理员都看到一个空连接列表**。
修法：给 `all-connections` 时同时 push `connections/*`。回归测试两条（全权成员能看到单条连接、受限成员只能看到被授的那条）。

> 这个 bug 单元测试抓不到（规则解析全对），只有真链路能抓 —— 正是这轮做真库验收的价值。

#### 环境事实（下次别再踩）

- 本机**没有 docker、没有 sqlite3/psql/mysql/postgres/duckdb 二进制**；`better-sqlite3` 也没预装。
- **DuckDB 不行**：`@duckdb/node-api` 与 `dbgate-plugin-duckdb` 都在，能连接、能查询，但本仓的分析器对 `duckdb_tables()` 返回空（`structure` 永远是 `[]`）。属引擎侧问题，与权限无关。
- SQLite 是单库引擎：`server-connections/list-databases` **必然返回 `[]`**（插件不实现 `listDatabases`），要用连接的 `defaultDatabase`。
- DDL 是首次分析之后跑的：**必须**先 `database-connections/sync-model`（`isFullRefresh: true`）再读 `structure`，否则拿到的是空模型。
- `connections/save` 收的是**扁平**的连接对象（不是 `{connection}`）；`run-script` 的参数名是 `sql`（不是 `script`）。

### 8.10 P2 开工前的决策（2026-10-14 已拍板）

1. **行级过滤与「执行脚本」强制互斥**：只要角色配了行级过滤规则，该库的 `run_script` 档位就不能给（能跑任意 SQL 就能绕开 WHERE 注入）。实现时在保存角色/校验配置时强校验 + UI 联动禁用，而不是只写提示。
2. **接受把当前用户身份传进子进程**：列级脱敏要在结果管线上生效，必须把成员与其脱敏规则从 API 主进程传到 `proc/sessionProcess.js` / `proc/databaseConnectionProcess.js`，再在 `handleQueryStream` 的结果路径上挂 transform。改动面比 P0/P1 大，属于独立一批。
3. **测试库已就位**：SQLite + `scripts/e2e-permissions.js` 的套路可复用于 P2 的验收（行级过滤看返回行、列级脱敏看返回值）。

下一批（P1 收尾）：**访问矩阵** —— 现在有真库了，行 = 连接下的库（单库引擎用 `defaultDatabase`），列 = 角色，格子 = 该角色的库级规则，可直接改；对象级用现有的角色页对象例外表格。

### 8.11 P1 第 5 批：访问矩阵（已在真库上验收）

**后端**：`permissions/get-access-matrix`（索要 `admin/users`）一次返回一整屏：
- `roles[]`：每个角色在 `(conid, database)` 上的库级规则 —— `level` / `levelId`（给下拉框）/ `ruleId`（有规则才能删）/ `memberCount`；`level: null` 表示"继承/无规则"。
- `users[]`：每个成员的**最终**档位（复用 `resolveUserAccess`）、是否能连上该连接、是否停用/过期。
- 一次最多解析 100 个成员（防止被当批量接口刷）。

配套：`permissionStore.getRoleDatabaseRule(roleId, conid, database)` —— 与引擎同规则（同角色内后者覆盖前者、`database_names_list` 忽略大小写、正则容错），有单测覆盖"后一条覆盖前一条"。

配套：`get-connection-list` 补了 `singleDatabase` / `defaultDatabase`（文件型引擎必须靠它拿库名）。

**前端**：`AdminMatrixTab.svelte`
- 连接选择 → 库（多库引擎走 `list-databases`；sqlite/duckdb 这类单库引擎自动回退到 `defaultDatabase`）。
- 矩阵：行 = 该库，列 = 角色（可编辑下拉，`''` = 删除该格的显式规则）+ 成员（只读徽章，显示最终档位/被拒/连不上）。
- **对象级下钻**：选一个角色 → 列出该库的表，逐表给对象级例外（走 `save-role-table` / `delete-role-table`）。
- 内置角色的格子禁用（权限由代码固定）。

**验收（真库，15/15 全过）**：在原有 11 条断言上加了 4 条矩阵断言 —— 角色格显示 `read_content` 且带 `ruleId`（可编辑）、成员格显示最终档位 `read_content`、成员格能连上该连接。

`packages/api`：**412 tests 全绿**（21/25 suite；4 个失败 suite 仍是既有的 Premium `storageDb` 缺模块）。6 个 Svelte 组件编译通过，零错误零 a11y 警告。

P1 至此只剩：操作开关已做、对象级已做、预览已做、矩阵已做；**未做**：以某成员身份打开数据库（impersonation）、对象级规则的"命中预演"列。

### 8.12 P2 第 1 批：列级脱敏（在真库上验收）

**纯函数**：`utility/columnMasking.js` —— `buildColumnMaskRules` / `findColumnMaskRule` / `maskValue` / `applyColumnMasks`，不依赖存储与请求上下文，19 条单测钉死：
- 模式 `hide`（整列不返回）/ `partial`（留前 3 后 2）/ `hash`（sha256 前 8 位）/ `null`（置空）
- 规则可限定表；不写表 = 任意表；同列多条规则**后者覆盖前者**
- 匹配走 `sourceColumnName`（真实来源列），所以 `SELECT phone AS p` 这种别名也能命中
- 不改动入参

**存储**：`roleColumns`（`role_id / connection_id / database_names_list / table_names_list / column_names_list / column_mask_mode`）。`readStore()` 先铺 `emptyStore()`，**老的 permissions.json 没有这个集合也不会炸**（有测试）。`deleteRole` 现在会一并清掉它。

**接线**：provider 新增 `getCurrentColumnMaskRules(req, conid, database)`；`hasPermission.js` 新增并导出 `loadColumnMaskRules(req, conid, database)`；`databaseConnections` 的 `queryData` / `sqlSelect` 在结果返回前调用 `maskQueryResult()`。走 provider 而不是直接查存储 —— provider 是唯一知道「请求 → 成员」映射的地方，env 登录/管理员密码登录的成员同样生效。

**为什么不需要穿进程边界**：`queryData` / `sqlSelect` 的结果是**以 JS 对象回到主进程**的，所以在主进程里改就行，比预想的简单（用户先前同意"把身份传进子进程"，实际只在流式路径上才需要）。

**⭐ 诚实的安全边界**：脱敏只覆盖「以对象返回」的结果。**流式导出（native backup / SQL dump）还没有接脱敏**，所以给 `testNativeOpPermission('backup')` 与 `nativeBackup` 加了守卫：**只要该成员在这个库上有脱敏规则，批量导出直接拒绝**（`Column masks are configured ... bulk export is not masked yet and is therefore refused`）。宁可拒绝，也不能出现"界面里脱敏、导出拿原文"。流式路径的脱敏是下一批。

**自己抓到的两个 bug**：
1. `hide` 只去掉了列元数据，**行里的值还在返回体里** —— 等于没隐藏。已修（连行键一起删），并有单测。
2. `deleteRole` 没有清理 `roleColumns`，删角色会留下孤儿规则。

**第二次踩到同一个坑**：`databaseConnections.test.js` 的全量 mock 打掉了新导入的 `loadColumnMaskRules`，3 个既有的备份测试直接红。已把该 mock 改成 `...jest.requireActual(...)` 部分 mock。**约定：以后 mock 这个模块一律用 requireActual 展开**，别再逐个列函数。

**验收（真库 E2E，19/19 全过）**，新增 4 条：
| 断言 | 结果 |
|---|---|
| 全权成员看到原始手机号 | `13800001111` |
| 受限成员的手机号被脱敏 | `138******11` |
| 结果里标注了被脱敏的列 | `maskedColumns.phone = 'partial'` |
| 受限成员批量导出被拒 | ✅ |

`packages/api`：**443 tests 全绿**（22/26 suite；4 个失败 suite 仍是既有的 Premium `storageDb` 缺模块）。6 个 Svelte 组件编译通过，零 a11y 警告。

### 8.13 P2 第 2 批：行级过滤（真库验收通过）

**★ 关键设计决定：不做「管理员写一段 WHERE 文本」，改成结构化规则**（列 + 比较符 + 值来源）。原因：
1. 把自由文本解析成 Condition AST 需要列清单上下文 —— 实测 `dbgate-filterparser` 的 `parseFilter` 在没有列清单时会把裸词当成 `like` 的**占位条件**，产出错误的 AST（`tenant = 'T-1042'` 被解析成 `%tenant%` + 一个无列的等值）；
2. 值最终要进 SQL，自由文本意味着要自己做转义与注入防护；结构化写法里列名是标识符、值走 AST 的 `value` 节点，由 `dumpSql` 统一转义。

规则形态：`建表列 + 操作符(= != > >= < <=) + 值来源(member.login/tenant/... 或字面量)`，多条规则 AND。
成员缺该字段时值取 `null` → 条件匹配不到任何行（**失败时收紧**）。

**注入点**：`database-connections/sql-select`（表格浏览走的正是这条路）。在 `select.where` 上 AND 一个 binary 条件，原 where 保留，不改动入参。

**★ 硬互斥（按用户决策）**：能跑任意 SQL 就能绕开注入，所以
- `testDatabaseRolePermission(conid, db, 'run_script')` 在**最前面**判断：该成员在此库有行过滤 → 直接拒（放在最前面是为了不被 `all-databases` 短路绕过）；
- `queryData`（裸 SQL，本身没有档位门槛）也加了同样的守卫。
两条都有 E2E 断言。

**验收（真库 E2E，24/24 全过）**，本轮新增 4 条：
| 断言 | 结果 |
|---|---|
| 全权成员浏览到全部行 | 2 行 |
| 受限成员只看到自己租户的行 | 仅 `alice`（`customers.tenant = ${user.tenant}`，成员 tenant=T-1042） |
| 受限成员裸 SQL 被拒 | ✅ `Row filters are configured ...` |
| 受限成员执行脚本被拒 | ✅ 同上 |

同时把 E2E 的列脱敏断言换到**另一个成员**（只有脱敏、没有行过滤）—— 否则它自己的 query-data 会被行过滤守卫拦下，这也说明两个特性在同一个 db 上共存时管理员需要知道这个组合。

`packages/api`：**474 tests 全绿**（23/27 suite；4 个失败 suite 仍是既有的 Premium `storageDb` 缺模块）。UI：角色页新增「行过滤」表格（连接/库/表/列/操作符/值来源/值），6 个 Svelte 组件编译通过、零 a11y 警告。

**P2 完成度**：列级脱敏 ✅（网格路径；流式导出被守卫拒绝）、行级过滤 ✅、操作开关 ✅。

### 8.14 P1 收尾：访问预览把「更细粒度」和它的后果说清楚（2026-10-14）

**为什么先做这个而不是流式导出的脱敏**：实地追了一遍导出链路 —— 界面的"快速导出"是
`database-connections/eval-json-script` 生成一段脚本，再由 `runners/start` 执行，数据从
`jsldata/stream-rows`（一个临时的 JSON-lines 存储）流出去。那个存储**没有可靠的表身份**，
按 (表, 列) 匹配的脱敏规则在这里只能靠猜；而 `nativeBackup` 更是数据库自己 dump，
Node 侧根本碰不到行。所以"把规则传进子进程"能覆盖的只是其中一段，收益不确定、风险不低。
**更好的做法是先把"哪些能力因此被禁掉"讲清楚**，别让管理员以为自己配了脱敏就万事大吉。

`getUserAccessRules` 扩展（预览页直接可见）：
- `columnMasks[]` / `rowFilters[]`：该成员身上生效的细粒度规则（带来源角色名）
- `restrictions.rawSqlBlocked`：有行过滤 → 裸 SQL / 执行脚本已被硬拒
- `restrictions.bulkExportBlocked`：有列脱敏 → 批量导出已被拒

预览页（`AdminAccessPreviewTab`）新增两张表 + 两个警示徽章，管理员一眼能看到「这个人被限制了什么、为什么」。

**验收（真库 E2E，30/30 全过）**，本轮新增 6 条：
行过滤成员 → `rowFilters` 1 条、`rawSqlBlocked=true`、`bulkExportBlocked=false`；
脱敏成员 → `columnMasks` 1 条、`bulkExportBlocked=true`、`rawSqlBlocked=false`。

`packages/api`：**477 tests 全绿**（23/27 suite）。6 个 Svelte 组件编译通过、零 a11y 警告。

**仍在的已知边界（写清楚，不假装完成）**：
1. 列脱敏只覆盖网格/查询结果；流式导出（quick export / native dump）未接 → 对有脱敏的角色**拒绝导出**。
2. 行过滤只作用于结构化 select 的**主表**；带 join / 子查询的 select 未处理。
3. 两者叠加在同一成员身上时，其 `query-data` 会被行过滤守卫拦下（E2E 因此拆成两个成员）。

### 8.15 P1 收尾：以某成员身份看数据库树（严格只读）✅ 2026-10-14

**安全设计（先说清楚，这是本批最容易被做错的地方）**：**不切换凭据**。数据库调用全程用**管理员自己的
身份**执行（管理员本来就有访问权），只是把结果**按该成员的规则过滤**一遍再返回。所以：
- 管理员不会因此多出任何他本来没有的访问能力；
- 全程只读（列出库 / 读结构），没有任何写操作；
- 不签发任何"以某成员身份"的 token，也就不存在被冒用的凭据。

**实现**：`permissions/get-user-visibility`（索要 `admin/users`），入参 `{ userId, conid }`：
1. 取管理员的连接清单（`connections.list`），按成员的连接授权过一遍；
2. 每个可见库用 `resolveUserAccess` 判库级档位，`deny` 的直接不出现在树里；
3. 读结构（`database-connections.structure`），逐表判对象级档位，`deny` 的丢掉；
4. 顺手把**列脱敏**与**行过滤**的标注挂到表上，管理员能一眼看出"这张表对他是什么样"。
5. 上限：连接 5 / 库 20 / 表 200，超出置 `truncated`，避免一次把几十个库的结构拉出来。

**UI**：访问预览页新增「以该成员身份看树」——选连接 → 看树（连接 → 库带档位徽章 → 表带角色/脱敏/行过滤标注），
并明确写了"只读预览，服务器以**你**的身份执行后按成员规则过滤，不切凭据、不写任何东西"。

**验证**：
- 单测：`permissions.test.js` 里把三个"真去连库"的控制器换成替身，断言过滤逻辑本身 —— 只出现被授权的连接、
  `deny` 的表不出现、`customers` 被加宽为 `create_update_delete`、脱敏与行过滤标注正确、无库规则的成员树里
  没有库。注意：**这些 mock 是必须的**，否则 jest 会因为 `require('./connections')` 链上的语法解析失败。
- 真库 E2E：**35/35 全过**，本轮新增 5 条（库级档位、被拒绝的表不出现、对象级加宽标注、行过滤标注、列脱敏标注）。

`packages/api`：**484 tests 全绿**（23/27 suite；4 个失败 suite 仍是既有的 Premium `storageDb` 缺模块）。6 个 Svelte 组件编译通过、零 a11y 警告。

**P1 至此全部完成。**

### 8.16 P2 收尾：使用限制（行数上限 / 超时 / 时段 / IP 白名单）✅ 2026-10-14

**模型**：限制挂在角色上 —— `role.limits = { maxRows, timeoutSeconds, allowedHours, allowedIps }`（0/空 = 不限）。
成员有多个角色时取**最严**：行数/超时取最小非零值；时段/IP 是名单，**任一角色不允许就不允许**。
`readStore` 先铺 `emptyStore`，老 permissions.json 没有 limits 也不会炸。

**判定与执行**：
- **时段 / IP**：`checkUserLimits(user, {ip, date})`，挂在 `testConnectionPermission` 的**最前面**
  （几乎所有数据库操作都会经过那里），拒绝时给明确文案（`Access is only allowed between 09:00-18:00` /
  `Access from <ip> is not allowed for this member`）。支持跨零点窗口（`22:00-06:00`）。
- **来源 IP 用 `req.ip`**（Express 解析后的 socket 地址）。**不做「信任 X-Forwarded-For」的危险默认** ——
  挂在反代后面必须自行配好 `trust proxy`，这条写进了代码注释与文档。
- **行数上限**：`sqlSelect` 在**语句层**收窄（`topRecords = min(现有, maxRows)`，最好的做法）；裸 SQL
  没法提前限行，只能在结果回来之后截断并打上 `truncatedByLimit` 标记（E2E 两条路径都断言了）。
- **超时**：`sqlSelect` 的 `commandTimeout` 收窄到成员限额。

**两个刻意的容错**：时段字符串写错（`whenever` / `25:00-99:99`）按**不限制**处理 —— 一个笔误不该把整组成员
锁在门外；IP 支持精确匹配、前缀匹配（`10.20.`）以及 IPv4-mapped 形式（`::ffff:10.20.1.5`）。

**UI**：角色页「使用限制」四个输入（最大行数 / 超时秒数 / 允许时段 / 来源 IP 白名单）。

**验收（真库 E2E，41/41 全过）**，本轮新增 6 条：
| 断言 | 结果 |
|---|---|
| 行数上限生效（`sqlSelect`） | 2 行数据只返回 1 行 |
| raw SQL 结果被截断并标注 | `truncatedByLimit = 1` |
| IP 不在白名单被拒 | ✅ |
| 时段外被拒 | ✅ |

`packages/api`：**490 tests 全绿**（23/27 suite；4 个失败 suite 仍是既有的 Premium `storageDb` 缺模块）。
6 个 Svelte 组件编译通过、零 a11y 警告。

**P2 至此只剩两项可选/超出当前范围的**：列脱敏的流式导出路径（现由守卫拒绝）、行过滤对 join/子查询的处理。

### 8.17 质量闸门与"浏览器级 E2E"的结论（2026-10-14）

**跑通了两个之前没跑过的仓库自带闸门**：
- `yarn translations:check` → `No problems found`（我新加的 UI 文案没有破坏翻译提取）。
- `prettier --check`：**发现我自己写的 4 个文件不合规**（`columnMasking.js` / `permissionStore.js` /
  `controllers/permissions.js` / `e2e-permissions.js`）——之前只做了"能编译、能过测试"，没做格式检查。
  已 `prettier --write` 修好，并复跑相关 4 个 suite（182 条）确认没被格式改动弄坏。

**前端真的进了产物（比"编译通过"更硬的证据）**：用仓库自己的 rolldown 构建
（`yarn workspace dbgate-web build`，成功，`build/bundle.js` 6.35 MB），然后在产物里核验：
| 内容 | 在 bundle.js 中出现 |
|---|---|
| AdminUsersTab / AdminRolesTab / AdminAccessPreviewTab / AdminAuthTab / AdminMatrixTab | 3 / 4 / 5 / 3 / 2 次 |
| `permissions/get-access-matrix`、`permissions/get-user-visibility` | 各 1 次 |
| `AdminRolesTab_allowedIps`（新 testid）、`columnMasks` / `rowFilters` | 1 / 2 / 3 次 |

**浏览器级 E2E：本机跑不起来，如实记录（不冒充完成）**。证据链：
1. Cypress 13 是 `e2e-tests` 的 devDependency（该目录不是 workspace，默认不安装）；
2. Cypress 需要它自带的 Electron，而 Electron 需要 GTK3 —— `ldconfig -p | grep libgtk-3.so.0` = **0 条**，
   且**没有 xvfb**；
3. 试图补装：`apt-get` 解析可行（需要 68.1 MB / 62 个包），但**卡在 `Get:27` 超过 10 分钟无进展**，
   镜像形同不可用，已终止。

→ 因此这一条 P0 验收（"哆啦A梦登录 → 授权 → 只见一个库"的 **UI** 端到端）**保持未勾选**。替代证据是：
API 级真库 E2E（41 条断言，覆盖 5 个管理页签实际调用的全部路由）+ 上面的产物核验。
**要真正勾掉它，需要一台能跑 headless Electron 的机器**（装 libgtk-3 / xvfb，并让 Cypress 二进制可下载）。
