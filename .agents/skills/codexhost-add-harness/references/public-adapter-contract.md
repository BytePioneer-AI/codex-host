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
- `close()`：释放 Adapter 控制的资源并结束输出流；只有显式声明 History replacement fence 时，才额外保证原生工作不能继续修改 Transcript 或 Workspace。

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
- `rollbackLastTurn`：生成删除最后一个 Turn 后仍可继续的 Session；不能修改调用方仍在使用的源 Session。Host 会携带当前确认的 Model、Thinking 和 Permission Mode，Adapter 必须在返回前保留或恢复这些配置。

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

## `close()` 契约

所有 `HarnessSession.close()` 在 Promise resolve 时都必须满足：

- `outputs` 已结束，并且 close 前已经发出的值会在结束前可被消费；
- 后续不能再接受命令或产生输出；
- Adapter 控制的 Transport、订阅、定时器和其他资源已经释放；
- 重复调用安全。

只有 `capabilities.history.replacementFence === true` 时，`close()` resolve 还必须证明该 Session 启动或控制的原生工作已经停止，并且不会继续修改 Native Transcript 或 Workspace。Host 才能在历史替换提交前用 `close()` 隔离旧 Session，并排空其输出。CLI/RPC Harness 通常需要等待子进程树退出；独立 Server Harness 需要停止订阅和它为该 Session 启动的 Server。仅断开一个仍可自主执行的监听器不满足 fence 契约。

`replacementFence` 是可选字段，遗漏与 `false` 等价；未声明 Rollback 的旧 Adapter 仍可直接解析，旧的 Rollback-capable Adapter 则必须显式迁移并证明 fence，否则按不兼容能力 fail closed。普通 `close()` 的资源和输出保证不能被推断为 native/workspace fence。

Session 的 `capabilities` 在其生命周期内必须保持不变。Host 会在候选 Session 打开时以及配置/历史异步校验完成后的提交边界重复检查 `replacementFence`；如果能力声明发生变化，替换会在关闭来源 Session 或写 Store 前失败。

## 能力声明

`HarnessSessionCapabilities` 是 Host 的行为依据，不是展示信息：

- `configuration.selectModel`：允许 `model.select`。
- `configuration.selectThinkingOption`：允许 `thinking.select`。
- `configuration.selectPermissionMode`：允许 `permissionMode.select`，且 `inspect()` 必须提供 Catalog。
- `history.fork`：快照应提供可用 Checkpoint，Adapter 应接受 `open({ kind: "fork" })`。
- `history.forkAcrossCwd`：仅在 `fork` 为 true 时可为 true。
- `history.replacementFence`：`close()` 可以作为 History replacement 的 Native work、Transcript 和 Workspace fence；遗漏视为 false。
- `history.rollbackLastTurn`：Adapter 应接受 `open({ kind: "rollbackLastTurn" })`，并且必须同时声明 `history.replacementFence=true`。
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

- 结束所有待处理 Interaction；
- 将活动 Item 和 Turn 置于唯一终态；
- 关闭子进程、SDK 流、Socket、订阅和定时器；
- 结束 `outputs`；
- 不因重复调用重复发出终态事件。

Adapter 应尽力取消原生活动任务；只有 Session 声明 `history.replacementFence=true` 时，才能保证 `close()` resolve 后这些任务已停止且不能再修改 Transcript 或 Workspace。

最小公共行为应通过 `packages/harness-adapter/src/testing.ts` 和 `packages/harness-adapter/test/text-session.test.ts` 的模式测试；原生转换再由 Adapter 自己的测试覆盖。
