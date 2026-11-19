# 接口索引：公共契约的全部成员

本页逐项列出插件可以实现的成员：必需还是可选、一句话语义、对应的规范。**签名以源码为准**。

- `TS`：`packages/harness-adapter/src/text-session.ts`
- `PL`：`packages/harness-adapter/src/plugin.ts`
- `MF`：`packages/shared-contracts/src/harness-plugins.ts`

公共接口新增或删除成员时，同步更新本页和[能力总表](capability-inventory.md)。

## Manifest（MF：`harnessPluginManifestSchema`）

| 字段 | 必需 | 语义 | 规范 |
|---|---|---|---|
| `manifestVersion` | ✓ | 固定为 1 | [加载](packaging-and-validation.md#manifest) |
| `id` | ✓ | 插件 ID，也是 Harness ID；`codex` 是保留 ID | 同上 |
| `name` | ✓ | 显示名称 | 同上 |
| `version` | ✓ | 插件自身的版本 | 同上 |
| `adapterApiVersion` | ✓ | 必须等于 `HARNESS_PLUGIN_API_VERSION` | 同上 |
| `entry` | ✓ | 插件内的 ESM 入口相对路径 | 同上 |
| `icon` / `iconStyle` | | 图标资源 / 受限的矢量或样式 | [连接页](spec-connections.md#manifest-展示字段) |
| `links` | | website / documentation / installation | 同上 |
| `installation` | | 只展示的安装指引 | 同上 |
| `notice` | | 本地化的提示 | 同上 |
| `launchCommand` | | 只能是 `true`：工厂接受持久化的启动路径 | [连接页](spec-connections.md#自定义启动路径) |

## 工厂模块（PL）

| 导出 | 必需 | 语义 | 规范 |
|---|---|---|---|
| `createHarnessAdapter(context)` | ✓ | 为每个 Host 连接返回一个 Adapter | [加载](packaging-and-validation.md#工厂与共享资源) |

`HarnessPluginContext` 字段：`environment`、`platform`、`managedRemoteHost`、`launchCommand?`、`brokerDescriptorPath?`、`openLocalUrl?`、`openLocalPage?`。

## HarnessAdapter（TS）

| 成员 | 必需 | 语义 | 规范 |
|---|---|---|---|
| `harnessId` | ✓ | 与 Manifest 的 `id` 一致 | [会话核心](spec-session-core.md) |
| `inspect(input?)` | ✓ | 检查安装、认证、Catalog 和能力；`purpose:"availability"` 是轻量模式 | [会话核心](spec-session-core.md#检查inspect) |
| `open(input)` | ✓ | create / resume / fork / rollbackLastTurn | [会话核心](spec-session-core.md#打开open)、[历史](spec-history.md) |
| `close()` | ✓ | 幂等地释放共享资源 | [会话核心](spec-session-core.md#命令并发与错误) |
| `installation(action)` | | 检查或更新原生 CLI 的版本 | [连接页](spec-connections.md#版本检查与更新) |
| `install()` | | 首次安装原生 CLI | [连接页](spec-connections.md#首次安装) |
| `sessionImport` | | `listCandidates()` + `resolveCandidate(id)` | [历史](spec-history.md#导入) |
| `subagents.readSnapshot(input)` | | 原生 Subagent 的只读 Transcript | [输出](spec-output-interactions.md#autonomous-turn-与原生-subagent) |
| `usageStatistics` | | 只读本地存储的全局统计 | [用量](spec-usage-accounts.md#全局用量统计) |
| `inspectAccount()` / `inspectAccounts()` | | 新鲜的账号额度查询 | [用量](spec-usage-accounts.md#账号额度与-credits) |
| `credits()` / `refreshCredits()` | | 同步读取 / 异步刷新账号额度缓存 | 同上 |

## HarnessSession（TS）

| 成员 | 必需 | 语义 | 规范 |
|---|---|---|---|
| `harnessId` | ✓ | 与 Adapter 的一致 | [会话核心](spec-session-core.md) |
| `capabilities` | ✓ | `configuration`、`history`、`subagents?`、`autonomousTurns?` | [能力总表](capability-inventory.md) |
| `initialState` | ✓ | 原生已确认的 nativeRef 和配置 | [会话核心](spec-session-core.md#配置与状态requested-不等于-effective) |
| `initialUsage` | ✓ | 初始用量快照，没有时为 null | [用量](spec-usage-accounts.md#会话用量快照) |
| `outputs` | ✓ | 单消费者的有序事件流 | [输出](spec-output-interactions.md) |
| `execute(command)` | ✓ | 六条公共命令 | [会话核心](spec-session-core.md#命令并发与错误) |
| `readSnapshot()` | ✓ | 只读的历史快照 | [历史](spec-history.md#只读快照) |
| `close()` | ✓ | 幂等，并结束 outputs | [会话核心](spec-session-core.md#命令并发与错误) |
| `refreshUsage()` | | 主动刷新用量 | [用量](spec-usage-accounts.md#会话用量快照) |

## 公共命令（`execute`）

| 命令 | 成功返回 | 语义 |
|---|---|---|
| `turn.start { turnId, input }` | `{ turnId }` | 只表示已接受，终态从 outputs 获取 |
| `turn.cancel { turnId }` | `{ cancellationRequested: true }` | 只表示已受理 |
| `interaction.respond { interactionId, response }` | `{ accepted: true }` | 回答审批或提问 |
| `model.select { model }` | `{ completed: true }` | 原生确认后才返回 |
| `thinking.select { thinkingOptionId }` | `{ completed: true }` | 同上 |
| `permissionMode.select { permissionModeId }` | `{ completed: true }` | 同上；`atCreate` 时拒绝 |

## 输出事件（`HostEvent`）

| 事件 | 语义 | 规范 |
|---|---|---|
| `session.state.changed` | 完整的已确认状态 | [会话核心](spec-session-core.md#配置与状态requested-不等于-effective) |
| `session.usage.changed` | 完整的用量快照 | [用量](spec-usage-accounts.md#会话用量快照) |
| `usage.request` / `usage.history` | 请求级计量事实 / 历史回放是否完整 | [用量](spec-usage-accounts.md#请求级计量) |
| `turn.started` / `turn.autonomous.started` | Host 发起的 / 原生自主发起的 Turn 开始 | [输出](spec-output-interactions.md#turn-生命周期) |
| `item.started` / `item.updated` / `item.completed` | Item 生命周期 | 同上 |
| `interaction.closed` | 交互关闭（responded / cancelled / expired / superseded） | [输出](spec-output-interactions.md#双向-interaction) |
| `turn.completed` | 唯一终态；附带 `nativeTurnRef?` | [输出](spec-output-interactions.md#turn-生命周期) |
| `subagent.state.changed` / `subagent.transcript.changed` | 父 Turn 结束后的 Subagent 变化 | [输出](spec-output-interactions.md#autonomous-turn-与原生-subagent) |
| `session.faulted` | 不可恢复的故障；之后结束输出流 | [输出](spec-output-interactions.md#session-状态usage-与故障) |

Interaction 输出的种类：`approval`、`question`。

Item 的种类：`agentMessage`、`reasoning`、`commandExecution`、`toolExecution`、`fileChange`、`contextCompaction`、`subagentDelegation`。

## 公共工具（优先复用）

| 包 | 工具 |
|---|---|
| `@codexhost/harness-adapter` | `HarnessOutputChannel`、`validateHostApprovalResponse`、`validateHostQuestionResponse`、`validateHostInteractionResponse`、`parseHostUsage`、`parseHostUsageRequest`、`parseHarnessAccountCredits`、`sanitizeDiagnosticTail` |
| `@codexhost/harness-adapter/session-import` | `sessionImportCandidate`、`sessionImportTitle`、`SessionImportScope`、`readStableFiles`、`sameFileFingerprint` |
| `@codexhost/harness-adapter/plugin` | `HarnessPluginContext`、`HarnessPluginModule` 等类型 |
| `@codexhost/harness-discovery` | `resolveHarnessExecutable`、`commandInvocation`、`withNodeRuntimeOnPath`、`createHarnessInstaller`、`createInstallationManager`、`npmInstallation`、`fetchInstallationText`、`newerInstallationVersion`、`versionFromOutput` |
| `@codexhost/shared-contracts` | 各种 schema；`encodeHarnessPluginRoute` / `decodeHarnessPluginRoute`；`localizeHarnessPresentation` |
