# 能力总表：一个 Harness 插件的全部功能

本页是功能清单的权威来源。开发开始时，把[能力清单模板](capabilities-template.md)复制到插件目录的 `CAPABILITIES.md`，然后逐行填写；交付和审查都以这份文件为准。修改本页的行、「必做」或「优先级」时，要同步修改模板。

## 必做与优先级

「必做」列：

| 取值 | 含义 |
|---|---|
| **必做** | 所有插件都必须实现。不实现就不能加载，或不能作为普通 Thread 使用 |
| **原生有则必做** | 原生 Harness 有这项能力时必须接入，不能降级成纯文本；原生没有时按「不支持时」一栏的方式表达 |
| **条件必做** | 满足条件时必做，条件写在功能说明里 |
| **可选** | 不做也能交付，Desktop 对应入口会显示为不可用 |
| **预装时必做** | 只有随 codexhost 预装发行时才需要 |

「优先级」列（决定实现顺序）：

| 取值 | 含义 |
|---|---|
| **P0** | 首个可运行版本必须完成：插件能加载、能对话、能取消、能恢复 |
| **P1** | 合入或交付之前必须完成 |
| **P2** | 可以放到后续迭代，单独提交 |

结论只能填：**支持 / 不支持 / 受限 / 待验证 / 不适用**。

接口路径简写：`TS` = `packages/harness-adapter/src/text-session.ts`，`PL` = `packages/harness-adapter/src/plugin.ts`，`MF` = `packages/shared-contracts/src/harness-plugins.ts`，`HM` = `packages/shared-contracts/src/harness-models.ts`。

## A. 基础契约

| # | 功能 | 必做 | 优先级 | 接口 / 声明位置 | 规范 | 关键验收 |
|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | `manifest.json`：`manifestVersion`、`id`、`name`、`version`、`adapterApiVersion`、`entry`（MF） | [加载](packaging-and-validation.md#manifest) | 通过 schema 校验；Manifest、Adapter、Session、Native Ref 中的 ID 一致 |
| A2 | 工厂 | 必做 | P0 | `createHarnessAdapter(context)`（PL） | [加载](packaging-and-validation.md#工厂与共享资源) | 能被真实 Loader 加载；每个 Host 连接一个独立实例；抛错前清理已创建的资源 |
| A3 | 检查 | 必做 | P0 | `adapter.inspect({cwd, refresh, purpose})` → `HarnessInspection`（HM） | [会话核心](spec-session-core.md#检查inspect) | 不创建用户 Session；未安装、未认证、不可用分别返回不同状态；`purpose:"availability"` 走轻量路径 |
| A4 | 创建 Session | 必做 | P0 | `open({kind:"create"})`（TS） | [会话核心](spec-session-core.md#打开open) | 省略 Model/Thinking 时由原生决定默认值；传播 `environment`；预热时不提交用户内容 |
| A5 | 执行 Turn | 必做 | P0 | `execute(turn.start)` + `outputs` 事件流（TS） | [输出与交互](spec-output-interactions.md#turn-生命周期) | 被拒绝的 Turn 不发事件；每个 Turn 只有一个终态；流式文本与完成文本一致 |
| A6 | 取消 | 必做 | P0 | `execute(turn.cancel)` | [输出与交互](spec-output-interactions.md#取消与后续-turn) | 取消后能立即开始下一轮；迟到的输出不污染新一轮 |
| A7 | 只读快照 | 必做 | P0 | `session.readSnapshot()` → `HostThreadSnapshot` | [身份与历史](spec-history.md#只读快照) | 不触发 Agent；重复读取时 Turn/Item 身份稳定 |
| A8 | 持久身份 + resume | 必做 | P0 | `state.nativeRef` + `open({kind:"resume"})` | [身份与历史](spec-history.md#resume) | Host 重启或空闲释放后能恢复同一会话并继续写入 |
| A9 | 错误与并发 | 必做 | P0 | `HarnessResult` / `HarnessErrorCode`（TS） | [会话核心](spec-session-core.md#命令并发与错误) | 忙碌时返回 `sessionBusy`；close 或 fault 之后返回 `invalidState`；诊断信息已脱敏 |
| A10 | 关闭 | 必做 | P0 | `adapter.close()`、`session.close()` | [会话核心](spec-session-core.md#命令并发与错误) | 幂等；结束 outputs；60 秒内完成；不残留进程或订阅 |

原生不支持 resume 时，A8 填「不支持」。这种插件只能作为「受限后端」交付，不能称为普通 Thread，也不能称为完整委派。

## B. 原生能力

| # | 功能 | 必做 | 优先级 | 接口 / 声明位置 | 不支持时 | 规范 |
|---|---|---|---|---|---|---|
| B1 | 切换 Model | 原生有则必做 | P1 | `capabilities.configuration.selectModel` + `execute(model.select)` | 声明 false；Catalog 如实反映原生，可以只有一个固定 Model | [会话核心](spec-session-core.md#配置与状态requested-不等于-effective) |
| B2 | 切换 Thinking | 原生有则必做 | P1 | `selectThinkingOption` + `execute(thinking.select)`；动态列表放在 `state.availableThinkingOptions` | 声明 false | 同上 |
| B3 | 权限模式 | 原生有则必做 | P1 | `selectPermissionMode` + `permissionModeScope: live/atCreate` + `inspection.permissionModes` | 声明 false，并且不提供 `permissionModes` | [会话核心](spec-session-core.md#执行意图与权限) |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | `create.executionPolicy: "unattended-full-access"` | open 返回类型化拒绝 | 同上 |
| B5 | Fork | 原生有则必做 | P1 | `history.fork` + `open({kind:"fork"})` + `NativeCheckpointRef` | 声明 false，open 返回 `unsupported` | [身份与历史](spec-history.md#fork精确保留前缀并独立继续) |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | `history.forkAcrossCwd`（要求 B5 也支持） | 声明 false | 同上 |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | `history.rollbackLastTurn` + `open({kind:"rollbackLastTurn"})` | 声明 false | [身份与历史](spec-history.md#rollback去掉最后一个完整-turn) |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | Item：`commandExecution`、`toolExecution`、`fileChange`（含 diff）、`reasoning`、`contextCompaction` | 原生没有对应内容时不产生该 Item | [输出与交互](spec-output-interactions.md#原生内容映射) |
| B9 | 审批 | 原生有则必做 | P0 | `HostApprovalInteraction` + `execute(interaction.respond)` | 不伪造审批 UI | [输出与交互](spec-output-interactions.md#双向-interaction) |
| B10 | 提问 | 原生有则必做 | P0 | `HostQuestionInteraction` | 不退化成普通文本，也不自动作答 | 同上 |
| B11 | 原生 Subagent | 原生有则必做 | P2 | `capabilities.subagents` + `subagentDelegation` Item + `subagent.*` 事件 + `adapter.subagents.readSnapshot` | 不声明该能力 | [输出与交互](spec-output-interactions.md#autonomous-turn-与原生-subagent) |
| B12 | 自主 Turn | 原生有则必做 | P1 | `capabilities.autonomousTurns.observe` + `turn.autonomous.started` | 记录限制；不静默丢弃后台结果 | 同上 |
| B13 | 会话用量 | 原生有则必做 | P1 | `initialUsage`、`session.usage.changed`、`refreshUsage()` | Usage 为 null | [用量与账号](spec-usage-accounts.md#会话用量快照) |
| B14 | 请求级计量 | 原生有则必做 | P2 | `usage.request` + `usage.history` 事件 | 不发送；费用继续使用原生快照 | [用量与账号](spec-usage-accounts.md#请求级计量) |
| B15 | 接收委派 | 必做（验证项） | P1 | 普通可写 Thread + 执行策略 + 环境传播；A8 与 B4 成立时，这里只做验证 | 报告受限 | [委派](spec-delegation.md) |
| B16 | 向下委派 | 原生有则必做 | P2 | 原生 Agent 能发现并调用 codexhost CLI | 报告「不能向下委派」 | [委派](spec-delegation.md#继续向下委派) |

说明：

- B9、B10 是 P0，因为原生发出审批或提问后如果没人接，Turn 会一直卡住。
- B12 是 P1，因为原生的自主输出如果不接入就会丢失。

## C. 产品化

| # | 功能 | 必做 | 优先级 | 接口 / 声明位置 | 缺少时的表现 | 规范 |
|---|---|---|---|---|---|---|
| C1 | 展示元数据 | 必做 | P1 | Manifest：`icon`、`iconStyle`、`links`、`notice`；权限模式的 `localizations` | 只显示 ID 和默认图标 | [连接页](spec-connections.md#manifest-展示字段) |
| C2 | 手动安装指引 | 必做 | P1 | Manifest：`installation`（commands / before / after / downloads） | 连接页没有安装说明 | 同上 |
| C3 | 版本检查与更新 | 必做 | P1 | `adapter.installation("check"\|"update")` | 连接页显示版本管理不可用 | [连接页](spec-connections.md#版本检查与更新) |
| C4 | 首次安装 | 可选 | P2 | `adapter.install()` | 没有一键安装 | [连接页](spec-connections.md#首次安装) |
| C5 | 自定义启动路径 | 条件必做：原生 CLI 随桌面应用安装、不在 PATH 中 | P1 | Manifest：`launchCommand: true` + `context.launchCommand` | 只能靠自动发现 | [连接页](spec-connections.md#自定义启动路径) |
| C6 | 会话导入 | 可选 | P2 | `adapter.sessionImport.listCandidates()` + `resolveCandidate()` | 不出现在导入页 | [身份与历史](spec-history.md#导入) |
| C7 | 全局用量统计 | 可选 | P2 | `adapter.usageStatistics` | 统计页没有该 Harness | [用量与账号](spec-usage-accounts.md#全局用量统计) |
| C8 | 账号额度 | 可选 | P2 | `adapter.inspectAccount()` / `inspectAccounts()`；会话浮窗用的缓存 `credits()` / `refreshCredits()` | 账号设置页没有该行，会话浮窗不显示额度 | [用量与账号](spec-usage-accounts.md#账号额度与-credits) |

## D. 插件外交付

| # | 交付物 | 必做 | 优先级 | 位置 |
|---|---|---|---|---|
| D1 | Workspace / 构建 | 预装时必做 | P1 | 根 `tsconfig.json` references、`package-lock.json` |
| D2 | 预装清单 | 预装时必做 | P1 | `scripts/release/harness-plugins.json` 的 `plugins`；新增运行依赖时同时更新 `runtimePackages` |
| D3 | 加载测试 | 预装时必做 | P1 | `packages/host-runtime/test/installed-harness-plugins.test.ts` |
| D4 | 文档 | 预装时必做 | P1 | `docs/harnesses/<id>/<id>-harness-integration.md`、`docs/index.md`、`docs/harnesses/capability-boundaries.md`、README 能力表；涉及时还要更新 `harness-plugin-runtime.md` 的安装/更新表和 `docs/product/usage-*.md` 的「已接入」列表 |
| D5 | 其他 | 可选 | P2 | `agent-group-preference.ts` 的默认显示顺序（未列出的排在最后）、`tools/renderer-binding` 诊断名单、e2e |

详见[加载、发行与验证](packaging-and-validation.md#插件外文件清单)。

## 审查规则

审查 `CAPABILITIES.md` 时逐条检查：

1. 模板中的每一行都在，「结论」列不为空，取值只能是五种之一。
2. 「必做」行不能填「不支持」或「待验证」。唯一的例外是 A8：填「不支持」时，交付范围必须写明「受限后端」。
3. 优先级为 P0 的行不能填「待验证」。
4. 填「支持」或「受限」的行，必须写实现位置（源码文件），以及证据（测试文件或实测记录）。
5. 「不支持」的行必须写原生依据，并且代码中的声明要与之一致。例如 B5 不支持，则 `history.fork` 必须为 false，open fork 必须返回 `unsupported`。
6. 「受限」的行必须在「受限与已知缺口」一节中说明限制范围。
7. 「插件外改动」中不能出现 Harness 专用的 Host 或 Renderer 分支。
