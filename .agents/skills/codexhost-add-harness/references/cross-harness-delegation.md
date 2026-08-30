# 跨 Harness 委派接入

当新的外部 Harness 需要参与 codexhost 的 Agent 互相委派时，使用本检查清单。

## 权威来源

读取以下文件的当前版本：

- `packages/harness-adapter/src/index.ts`
- `packages/harness-adapter/src/text-session.ts`
- `packages/shared-contracts/src/harness-models.ts`
- `packages/host-runtime/src/delegation-types.ts`
- `packages/host-runtime/src/delegation-cli.ts`
- `packages/host-runtime/src/harness-delegation-coordinator.ts`
- `packages/host-runtime/src/delegation-snapshot.ts`
- `packages/host-runtime/src/external-thread-runtime.ts`
- `packages/protocol-core/src/model-routing.ts`
- `packages/host-runtime/src/adapter-composition.ts`

使用 [current-harness-implementations.md](current-harness-implementations.md) 选择最接近的传输实现，以及各项能力最合适的参考实现。公共语义同时参见 [public-adapter-contract.md](public-adapter-contract.md) 和 [thread-lifecycle-and-history.md](thread-lifecycle-and-history.md)；上述源码接口仍然是权威依据。

## 架构规则

外部委派由 `HarnessDelegationCoordinator` 统一实现。新的外部 Harness 必须通过公共 `HarnessAdapter` 和 `HarnessSession` 接口完成接入。除非原生系统确实无法通过这些接口表达，并且已经记录这种语义差异，否则不要在 Coordinator 中增加目标 Harness 专用分支。

完整 Agent 协调仍只使用这些公共操作：

- `HarnessAdapter.inspect()`：发现 Model、Thinking、Permission Mode 和能力；
- `HarnessAdapter.open({ kind: "create" | "resume" | ... })`：创建或恢复普通可写 Session；
- `HarnessSession.execute(turn.start)`：首次任务和后续消息；
- `HarnessSession.execute(turn.cancel)`：取消当前 Turn，但保留 Session 与历史；
- `HarnessSession.readSnapshot()` 与 `outputs`：非消费性观察历史、运行进度和终态；
- `OpenSessionInput.environment`：让当前 Agent 继续向其他 Harness 委派。

不要新增 `adapter.delegate()`、Harness 专用 send/cancel、Delegation 专用 Catalog 或目标专用 CLI 路由。原生 Codex 使用特殊的官方协议路径，不是新增外部 Harness 的实现模板。

## Harness inspection 与委派配置

注册后的 Harness 必须可由通用 `codexhost harness inspect <harness>` 路径调用。外部 Harness 直接复用 `HarnessAdapter.inspect({ cwd, refresh })`；inspection 不创建用户 Thread，不改变 Session 配置，也不发送 Prompt。

Model 与 Thinking 的协调规则：

- `HarnessModelRef` 由 Adapter 拥有，在 Host、CLI 和其他 Adapter 中保持 opaque；Host 不解析 Provider 或原生 Model ID；
- inspection 返回的 Ref 和 Thinking ID 必须满足共享 schema，并可原样传入 `open({ kind: "create", model, thinkingOptionId })`；
- `supportedThinkingOptionIds` 必须准确表达每个 Model 支持的 Thinking；只指定 Thinking 时，Host 使用 inspection 的默认 Model 做前置验证；
- Adapter `open()` 仍是最终原生校验点，因为 inspection 可能过期；
- 调用方未指定 Model 或 Thinking 时，相应字段必须保持省略。不得从 Catalog、Renderer 最近偏好、其他 Thread 或静态表填充默认值；
- requested 配置只记录调用方显式请求；effective 配置只能来自 `initialState`、有序 `session.state.changed` 或 `readSnapshot().state` 的原生确认，不能由 requested 值推断。

显式 Model/Thinking 路径必须通过通用 Coordinator 工作；新 Harness 不得为选择配置增加委派专用实现。

## 接收委派任务的必要条件

Adapter 必须：

- 暴露稳定的 `harnessId`；
- 实现 `open({ kind: "create", cwd, environment, executionPolicy, model?, thinkingOptionId? })`，对未指定配置保持省略；
- 返回能够接受文本 `turn.start` 命令的 `HarnessSession`；
- 通过 `outputs` 输出标准 `HarnessOutput` 事件；
- 在 `initialState.nativeRef` 中提供稳定的 `NativeSessionRef`，或者及时通过 `session.state.changed` 提供；
- 在发出的 Turn 和 Item 事件中保留 Host 提供的 `turnId`；
- 发出完整且一致的生命周期：`turn.started`、可见 Item，以及唯一的终态 `turn.completed` 或类型化的 Session fault；
- 使用 `HostThreadSnapshot` 实现 `readSnapshot()`，使已完成结果和恢复后的历史能够被投影；
- 实现 `close()`，且关闭后不遗留仍在运行的原生 Session Transport；
- 返回类型化的 `HarnessResult` 错误，不直接泄漏原生协议错误。

需要通过 `codexhost thread read` 对外可见的最终回答必须表示为 `agentMessage` Item。需要在运行过程中对外可见的进度也必须表示为 Agent Message。Reasoning、Command、Tool Output 和 File Activity 应继续使用各自的 Item 类型，不得被提升为委派结果。

`executionPolicy: "unattended-full-access"` 是 Host 执行意图。Adapter 应按 [public-adapter-contract.md](public-adapter-contract.md) 映射、由已验证的原生基线满足，或明确拒绝。不要为 Pi 一类不需要权限设置的 Harness 猜测原生参数。

## 持久化和恢复的必要条件

如果原生 Harness 能够恢复 Session，则实现 `open({ kind: "resume", nativeRef, cwd, environment, knownTurnRefs })`。恢复后的 Session 必须保持相同的原生身份，并通过 `readSnapshot()` 返回历史，不得将历史重放为新 Turn。

正式进入 Desktop 普通会话列表并声明完整 Agent 协调能力的 Harness 必须支持可写 resume。委派子 Thread 是持久化普通 Thread，Host 重启后仍应能够读取历史、继续 `thread send` 和取消新活动 Turn。

如果原生 Harness 确实不支持恢复，可以作为受限后端原型明确声明，但不得声称支持完整委派、持久化普通 Thread 或完整 Agent 协调。目前公共产品路径不会把缺少 resume 的 Session 自动降级成 ephemeral Thread；若未来需要该产品语义，应单独设计 capability、持久化和恢复行为。

Fork 和 rollback 是独立能力。仅当原生语义与 `OpenSessionInput` 一致时才支持；否则返回类型化的 `unsupported` 错误，并将相应的 History 能力声明为不可用。

## 后续消息与取消

委派创建后，Thread 必须保持普通可写 Session 语义：

- 首次 Turn 完成、失败或取消后，空闲 Session 能再次接受 Host 提供的新 `turn.start`；
- 活动 Turn 存在时，第二个 `turn.start` 返回 `sessionBusy`，不排队、不并发、不取消旧 Turn；
- `turn.cancel` 只请求取消匹配的当前 Turn，不删除 Native Session，不清空历史；
- 空闲 Thread 的 Host 控制面可以返回 `cancelled: false`，Adapter 不需要伪造原生取消；
- 取消终态后 Session 仍可继续接收后续 Turn；
- `readSnapshot()` 返回所有已持久化轮次，后续 Turn 继续使用 Host 分配的 `turnId` 和稳定 Native Turn identity。

这些行为由 `HarnessSession.execute()` 和 `readSnapshot()` 表达。不要为 `codexhost thread send` 或 `thread cancel` 增加 Harness 专用接口。

## 从该 Harness 内继续向下委派的必要条件

每一种 Session 打开路径都必须将 `OpenSessionInput.environment` 传递到原生 Agent 的进程或执行环境中，包括 create、resume，以及受支持时的 fork 和 rollback。

Host 提供的环境变量包括：

- `CODEXHOST_CLI_PATH`
- `CODEXHOST_RUNTIME_ENDPOINT`
- `CODEXHOST_RUNTIME_TOKEN`
- `CODEXHOST_THREAD_ID`

Adapter 不得重命名、自行发现、自行生成或替换这些值。委派时不得回退使用从 `PATH` 中找到的 `codexhost` 可执行文件。子 Agent 必须原样接收 Host 提供的 CLI 路径和私有 Runtime 凭据。

`CODEXHOST_THREAD_ID` 标识当前 Host Thread，并用于隐式推断父 Thread。丢失该变量会破坏正确的委派父子关系。丢失 Runtime endpoint 或 token 会导致子 Agent 无法调用私有 Runtime。

如果原生 Harness 的沙箱阻止本地 Runtime 连接，应直接呈现相应错误；不得静默切换到其他 Runtime，也不得通过注入隐藏 Turn 绕过限制。

递归委派验证至少覆盖「目标 Harness 接收任务」和「该 Harness 内的 Agent 使用注入 CLI/Runtime 信息继续委派另一个 Harness」两层。环境变量只授予 Runtime 访问能力，不允许 Adapter 自动创建隐藏 Turn 或主动回流子任务结果。

## 注册位置

当前仓库使用显式注册。将新 Harness 添加到所有适用位置，包括：

- `packages/protocol-core/src/model-routing.ts` 中的 Harness ID 和 Transport Model 映射；
- `packages/host-runtime/src/adapter-composition.ts` 中的 Adapter 创建逻辑；
- 当前项目结构要求的包导出、Workspace 依赖、发布打包和测试；
- 正式 Desktop 产品接入时，[renderer-product-integration.md](renderer-product-integration.md) 中的 Renderer Agent、Transport Model 和 Desktop Control 注册。

注册完成后，通用外部委派应能通过公共 Adapter Map 找到该 Adapter。不要为新 Harness 增加单独的 Delegation CLI 命令或专用控制服务路由。

## Interaction 与人工接管

Adapter 仍必须完整实现原生支持的 Approval/Question，并通过 `HostInteraction` 与 `interaction.respond` 保持当前 Turn。当前 Delegation CLI 尚未提供 `thread respond`；阻塞的委派 Interaction 可通过返回的 `deepLink` 在 Desktop 中人工处理。

因此：

- 不得为了无人值守伪造 Approval 或 Question 回答；
- 不得把待处理 Interaction 转成普通 Agent Message；
- 不得因 CLI 暂无回复命令而删掉 Adapter 的 Interaction 能力；
- 应明确测试 Interaction 挂起时 Thread 仍可观察、可取消，人工回复后能正常完成。

## 结果兼容性

委派观察依赖标准 Thread 投影。确认：

- 运行中的 Agent Message 会出现在 pending Turn 投影中；
- 已完成的 Agent Message 会出现在快照历史中；
- 原生成功、失败和取消状态会映射为相应的标准 Turn outcome；
- 生成公共结果时不依赖原生私有 Transcript；
- 读取快照不会启动 Turn、发送输入、消费事件或将消息标记为已读。

## 聚焦验证

添加聚焦测试，证明：

1. `inspect({ cwd, refresh })` 通过通用 Harness inspection 返回准确 Catalog、默认值和 capabilities，且不创建用户 Session。
2. 省略 Model/Thinking 时，`open(create)` 不收到人为填充的默认值；目标 Harness 自己确认 effective 配置。
3. 显式 Model/Thinking 使用 inspection 返回的 opaque ID，传到 `open(create)` 并由原生系统最终确认；非法组合明确失败。
4. `create` 能接收并传递 Host 环境变量，并正确处理 `unattended-full-access` 执行意图。
5. 委派的首次文本 Turn 能够启动，并保留 Host `turnId`。
6. Native Session identity 能及时提供，以便持久化。
7. 运行中的 Agent 文本可以作为可见进度被观察。
8. 已完成的 Agent Message 可以作为最终结果读取。
9. 空闲 Session 接受后续 `turn.start`；忙碌时返回 `sessionBusy`，不排队或并发。
10. `turn.cancel` 产生取消终态、保留 identity 和历史，并允许之后继续新 Turn。
11. `readSnapshot()` 不会修改 Session 或 Thread，并能返回多轮稳定历史。
12. `resume` 在 Host 重启后恢复相同 identity、配置和历史，且恢复的 Thread 仍可继续写入。
13. 失败、取消和 Session fault 会产生相应的唯一终态。
14. 原生 Harness 支持 Interaction 时，挂起、人工响应、取消和关闭生命周期正确。
15. 受支持的 fork/rollback 行为准确；不支持时明确声明并返回 `unsupported`。
16. 注册后的 Harness 可以被通用 inspect/start/send/cancel/read/wait/list 接受，不需要在 Coordinator 中增加目标专用分支。
17. Harness 内的 Agent 原样接收 Runtime 环境，并能在执行环境允许时继续向另一个 Harness 委派。

测试应通过 Adapter 的公共接口进行。只有原生协议转换和生命周期边界情况才需要增加原生 Transport 测试。

## 完成标准

只有满足以下条件，才能认为新 Harness 具备完整 Agent 协调能力：它能够通过 `HarnessAdapter` 接受通用 inspection 与显式/默认配置，通过普通可写 `HarnessSession` 接收首次和后续任务、取消当前 Turn，通过标准事件和快照发布非消费性的进度、结果与多轮历史，在 Host 重启后恢复同一可写 Thread，并原样保留 Host 提供的委派环境，使其 Agent 在执行环境允许访问本地 Runtime 时能够继续向下委派。任何不支持、受限或依赖人工 Interaction 的部分都必须明确报告。
