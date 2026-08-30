# 公共 Adapter 契约

本文说明新增外部 Harness 必须遵守的公共接口语义。接口签名以 `packages/harness-adapter/src/text-session.ts` 和 `packages/shared-contracts/src/` 的当前源码为准；本文只记录从类型本身不容易看出的约束。

## 接口分工

### `HarnessAdapter`

`HarnessAdapter` 是 Host 使用某个外部 Harness 的入口：

- `harnessId`：稳定的公共 Harness 身份，必须与注册和 Native Ref 中的 ID 一致。
- `inspect()`：检查安装、可用性、Model Catalog、Permission Mode Catalog 和能力，不创建用户 Session。
- `open()`：根据 `OpenSessionInput` 创建或恢复 `HarnessSession`。
- `subagents`：仅在能够读取原生 Subagent Transcript 时提供。
- `close()`：关闭所有检查 Transport、活动 Session 和共享连接；调用必须幂等。

### `HarnessSession`

`HarnessSession` 表示一个可继续执行的原生会话：

- `capabilities`：当前 Session 的真实能力。
- `initialState`：打开时已经确认的 Native identity 和配置。
- `initialUsage`：打开时可靠的完整 Usage；未知时为 `null`。
- `outputs`：单消费者、有序的异步输出流。
- `commands`：可选的 Harness 专用命令能力。
- `readSnapshot()`：只读历史和当前状态。
- `execute()`：执行 Turn、取消、Interaction 响应和配置变更。
- `refreshUsage()`：仅在原生系统支持主动刷新时提供。
- `close()`：终结活动操作、关闭 Transport 并结束输出流。

## `inspect()` 契约

`inspect()` 应：

- 在指定 `cwd` 下检查真实可用性，因为 Model、配置或认证可能与项目目录有关；
- 支持 `refresh` 绕过成功缓存；
- 返回 `ready`、`notInstalled`、`unavailable` 或 `error`，不得通过抛异常表达预期检查失败；
- 在 `ready` 时返回经过共享 schema 校验的 Catalog 和能力；
- 保证 `permissionModes` 是否存在与 `selectPermissionMode` 一致；
- 在失败信息中提供稳定错误码，并可附加 `stage`、`durationMs` 和已清理的 `stderrTail`；
- 关闭为检查创建的临时 Transport。

可参考 Pi 的按 cwd 缓存和 Claude Code 的分阶段检查。使用 `packages/harness-discovery/src/` 统一处理 PATH、版本管理器目录和 Windows shim；不要在每个 Adapter 重写发现算法。

## `open()` 契约

`OpenSessionInput` 当前有四种模式：

- `create`：创建空的、独立的原生 Session；可携带 Model、Thinking、Permission Mode 和 `executionPolicy`。
- `resume`：以相同 Native Session identity 恢复可继续会话；`knownTurnRefs` 用于稳定对齐已持久化 Turn。
- `fork`：从指定 Checkpoint 创建独立 Native Session，不能修改源会话。
- `rollbackLastTurn`：生成删除最后一个 Turn 后仍可继续的 Session；不能修改调用方仍在使用的源 Session。

所有模式都必须：

- 验证 `cwd` 和 Native Ref 所属 `harnessId`；
- 传递 `environment` 到实际执行 Agent 的原生进程或环境；
- 将预期失败返回为 `HarnessResult`；
- 失败时清理已经创建的 Transport、临时 Session 或派生资源；
- 返回能力和状态一致的 `HarnessSession`。

`create.executionPolicy` 表达 Host 的执行意图，不等同于某个 Harness 的 Permission Mode ID。Adapter 必须明确采用以下一种处理方式：

- 将意图映射为原生 Permission Mode、Sandbox、Approval Policy 或其他等价配置，并确认应用成功；
- 当 Harness 已验证的原生执行基线天然满足该意图时，明确接受但不传递额外权限参数；这是有测试覆盖的 deliberate no-op，不是遗漏实现；
- 无法保证该意图时返回类型化的 `unsupported` 或更精确错误。

`open()` 成功表示 Adapter 已接受并满足该策略，不表示一定发生了原生配置写入。Adapter 不得传递目标 Harness 不支持的猜测参数，也不得把一个尚未确认的 requested Permission Mode 冒充 effective 状态。

History 的详细要求见 [thread-lifecycle-and-history.md](thread-lifecycle-and-history.md)。跨 Harness 环境要求见 [cross-harness-delegation.md](cross-harness-delegation.md)。

## 能力声明

`HarnessSessionCapabilities` 是 Host 的行为依据，不是展示信息：

- `configuration.selectModel`：允许 `model.select`。
- `configuration.selectThinkingOption`：允许 `thinking.select`。
- `configuration.selectPermissionMode`：允许 `permissionMode.select`，且 `inspect()` 必须提供 Catalog。
- `history.fork`：快照应提供可用 Checkpoint，Adapter 应接受 `open({ kind: "fork" })`。
- `history.forkAcrossCwd`：仅在 `fork` 为 true 时可为 true。
- `history.rollbackLastTurn`：Adapter 应接受 `open({ kind: "rollbackLastTurn" })`。
- `subagents.observe`：输出标准 Subagent 生命周期。
- `subagents.readTranscript`：Adapter 提供 `subagents.readSnapshot()`。
- `autonomousTurns.observe`：能够输出不是由当前 Host `turn.start` 发起的原生 Turn。

能力为 false 时，相应命令或打开模式应返回 `unsupported`，不得执行部分操作。能力为 true 时，不能依赖 Harness 专用 Host 分支补齐语义。

## Session 状态

`HarnessSessionState` 只包含已由原生系统确认的状态：

- `nativeRef`
- `effectiveModel`
- `resolvedModelLabel`
- `effectiveThinkingOptionId`
- `availableThinkingOptions`
- `effectivePermissionModeId`

规则：

- Native identity 可以在第一次原生启动后通过 `session.state.changed` 补充，但建立后不能改变。
- Model 改变可能同时改变可用 Thinking 选项；应在同一个完整状态中发布修正结果。
- 配置命令必须等原生系统确认成功后再发布状态并返回成功。
- `initialState`、后续状态事件和 `readSnapshot().state` 应保持一致。

## 命令和并发

Session 必须显式控制并发，而不是依赖原生调用偶然串行：

- 第二个 `turn.start`、Model/Thinking 配置写入和 History 操作默认与活动操作互斥；冲突返回 `sessionBusy`，并标记 `retryable: true`；
- `interaction.respond` 必须能在所属 Turn 活动时执行；
- Permission Mode 是否可在活动 Turn 中改变取决于原生语义，允许时仍须与同类配置写入串行，不允许时返回 `sessionBusy`；
- 空文本 Turn 返回 `invalidRequest`；
- 取消必须引用当前活动 Turn；
- Interaction 响应必须引用当前待处理 Interaction；
- 不受支持的命令返回 `unsupported`；
- Session 已关闭或 fault 后返回 `invalidState`。

`turn.start` 返回成功表示已接受任务，不表示 Turn 已完成。被拒绝的 Turn 不能发出任何生命周期输出。

## 错误契约

原生错误必须归一化为 `HarnessError`。优先使用精确错误码：

- 安装与认证：`notInstalled`、`authenticationRequired`、`unavailable`
- 身份与并发：`sessionNotFound`、`sessionBusy`、`checkpointNotFound`
- 调用问题：`unsupported`、`invalidRequest`、`invalidState`
- 原生运行：`protocolError`、`processExited`、`nativeFailure`
- Adapter 缺陷：`internalError`

`retryable` 应表达相同调用在条件变化后是否可能成功。`diagnostic` 和 `stderrTail` 不得包含凭据；使用 `sanitizeDiagnosticTail()` 清理外部诊断文本。

## Usage 和 Harness Commands

Usage：

- `HostUsage` 字段必须通过 `parseHostUsage()` 的约束；
- `session.usage.changed` 是完整替换快照，不是字段 patch；
- 无可靠数据时发布 `null`；
- `observedForTurnId` 仅在确定对应 Turn 时提供；
- Usage 采集失败不应默认使正常 Turn 失败。

Harness Commands：

- 通过可选 `session.commands` 暴露；
- `list()` 返回经过共享 schema 校验的 Catalog；
- `execute()` 使用 Host 提供或生成的 `turnId`，并通过普通 Turn/Item 生命周期投影结果；
- 未声明的 Command ID 返回 `unsupported` 或 `invalidRequest`。

## 关闭契约

`Session.close()` 和 `Adapter.close()` 必须幂等：

- 关闭或取消原生活动任务；
- 结束所有待处理 Interaction；
- 将活动 Item 和 Turn 置于唯一终态；
- 关闭子进程、SDK 流、Socket、订阅和定时器；
- 结束 `outputs`；
- 不因重复调用重复发出终态事件。

最小公共行为应通过 `packages/harness-adapter/src/testing.ts` 和 `packages/harness-adapter/test/text-session.test.ts` 的模式测试；原生转换再由 Adapter 自己的测试覆盖。
