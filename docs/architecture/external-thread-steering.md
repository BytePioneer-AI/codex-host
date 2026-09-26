# 外部 Thread 的「调整方向」

codexhost 对外部 Harness Thread 保留一个「调整方向」操作，按当前 Session 的能力选择送达方式：

- **原生同轮插入**：Session 声明 `capabilities.steer` 时，Host 发送公共命令 `turn.steer`，由 Adapter 调用 Harness 自己的插入原语，在原生安全边界把输入送入**当前 Turn**，不取消、不另起 Turn。
- **停止后重发（退路）**：Session 未声明能力时，Host 继续取消当前 Turn，等待它终结，再把本次输入作为新 Turn 执行。

早期设计没有公共 `turn.steer`，因为当时能统一确认的外部 Harness 语义只有停止后重发。现在 Pi RPC 已提供可验证的同轮插入和接受回执；用显式 capability 让 Adapter 选择加入，可以保留各 Harness 的真实语义，而未加入的 Adapter 仍走原有退路。因此本次改变的是能力足够时的送达方式，不改变停止后重发的默认行为。

官方 Codex Thread 仍透传原生 `turn/steer`。Pi 的原生依据与验证层级见 [`../harnesses/pi/pi-steer.md`](../harnesses/pi/pi-steer.md)。

## 公共契约与执行

- `HarnessSessionCapabilities.steer` 只有在 Session 能把输入交给原生同轮插入原语时才为 `true`；缺省表示不支持。
- `TurnSteerCommand { turnId, input }` 定义在 `packages/harness-adapter/src/text-session.ts`。Adapter 在 Harness 确认接受或入队后返回 `{ accepted: true }`，不等待插入实际执行完毕。
- `ExternalTurnSteering` 统一校验非空文本、`expectedTurnId` 和 `threadId + clientUserMessageId` 去重。原生拒绝不会自动改走退路，也不会自动重试。
- `turn/steer` 回执包含 `turnId` 和 `delivery`：`activeTurn` 表示送入当前 Turn，`newTurn` 表示停止旧 Turn 后开始了新 Turn。

原生同轮插入成功后，Host 在当前 Turn 发布 `userMessage` Item。Desktop 提交带 `clientUserMessageId` 时，投影把它写入 Item 的 `clientId`，用于结算 Desktop 的乐观 steer 消息；Adapter 不发布这条 Host Item。刷新后的历史仍完全按 Adapter 的原生历史解析，不把不同的原生 Turn 强行合并。

Pi 的历史会把插入文本保存成新的用户条目。Pi Adapter 因而按“原提问加本轮已接受插入数”校验新用户条目数量，并仍把第一条原提问绑定为当前 Host Turn 的原生身份。

## Fork 与撤销窗口

原生历史可能已经在插入点分轮，而 Desktop 在重新读取前仍把内容显示为一个 Turn。Host 在内存中用 `ExternalThread.steeredTurnIds` 记录插过队的 Host Turn：

- 对该 Turn 的 Fork，以及该 Thread 的撤销，返回 `-32080` 并要求重新打开 Thread。
- Desktop 重新读取并成功刷新历史后清除已结束 Turn 的标记，此时操作按新的原生 Turn 边界执行。
- 标记不持久化；Host 重启后自然消失。

这项保护只覆盖 Desktop 视图与原生历史暂时不一致的窗口，不改变 Fork 或回退的持久化格式。

## 停止后重发退路

- `AppServerHost` 按 Thread 所有权分流 Desktop `turn/steer`，外部 Thread 不会落入官方 Account 查找。
- `ExternalTurnSteering` 在取消前注册指定旧 Turn 的终态等待，再调用现有 `turn.cancel`。取消 acknowledgement 不等于完成。
- 等待旧 Turn 的 Interaction/Item 关闭、终态身份持久化及 Desktop 终态通知写出后，Host 复用普通 `turn/start` 的底层启动函数，分配真实的新 Host Turn ID。
- 同 Thread 的其他 start 和 Harness command 不能抢占替换过程。若原生自主 Turn 已先开始，替换失败，不取消该 Turn。
- 取消与终态等待合计最多 20 秒。超时、Session fault、输出流结束、Host 关闭、显式停止、旧轮失败或持久化失败均不再自动启动新轮。
- 成功回执在当前连接内有界保留，用于 outcome-unknown 重试；不承诺跨 Host 重启的 exactly-once。

普通停止仍调用 Adapter 原来的取消实现。本功能不增加统一强杀策略，也不回滚旧 Turn 已完成的文件修改。

## Renderer 接入

Renderer 在展示输入前调用 `codexhost/thread/steering/inspect`，读取 `official`、`activeTurn` 或 `newTurn`。Host 执行和预检读取同一个 Session capability：

- `official` 与 `activeTurn` 使用 Desktop 自己的 steer 展示，乐观消息属于当前 Turn。
- `newTurn` 继续使用 `renderer-external-steering.ts` 的停止后重发展示：先走 Desktop 的普通 `startTurn` 占位，再只把本次出站 `turn/start` 转换成 `turn/steer`。
- follower 窗口继续使用 Desktop 原有 owner 转发；失败不暗中重试或入队。

Host 和 Renderer 必须配套发布。只升级 Host、让旧 Renderer 仍按停止后重发方式展示原生同轮插入，不属于支持路径。

### 当前边界

- 公共 Harness 输入只支持文本；图片、空输入和 tool response 在送达前拒绝。
- 当前 Turn 没有确认的 ID 时不猜测目标，也不把过期目标改为另一 Turn 重试。
- 原生语义差异照实保留；过晚的插入如何处理、历史如何分轮均由 Harness 决定，Host 不补偿。
- 当前 base 只有 Pi 声明 `capabilities.steer`；其他 Adapter 接受公共命令类型但返回 `unsupported`，因此保持停止后重发。
- 原生乐观消息结算依据 Codex Desktop **26.915.31945 / build 9922** 的只读 Bundle 核查：`clientId` 等于 `clientUserMessageId` 的 `userMessage` 会结算待定 `steeringUserMessage`。该核查不是运行中 Desktop 实测。

原有跟进消息队列、版本化 Renderer 绑定和服务端队列排除规则不变。

## 验证

- `packages/host-runtime/test/external-turn-steering.test.ts`：原生插入不取消、按消息去重、失败释放回执，以及停止后重发的终态等待与失败边界。
- `packages/host-runtime/test/app-server-host.native-steering.test.ts`：Desktop 原生插入的 `clientId` 投影、送达方式查询、Fork/撤销窗口和重新读取后放行。
- `packages/protocol-core/test/codex-ui-projector.test.ts`：插入的 `userMessage` 在实时与历史投影中留在所属 Turn。
- `packages/renderer-extension/test/renderer-external-steering*.test.ts`：按送达方式选择 Desktop 展示，并保持 RpcTarget、owner/follower、失败和卸载语义。
- `packages/adapters/pi/test/pi-steer.test.ts`：Pi capability、RPC 参数、非活跃目标、身份计数、数量不符和忙时 start。

2026-09-24 曾用 Pi 0.85.1 经 `PiAdapter` 实机核对原生插入；本次向上游基线移植只运行合成测试，没有重新运行真实 Harness 或 Desktop。类型检查和合成测试不能替代发布前的流式文本、工具运行、交互、连续提交、刷新历史、多窗口与远端连接验收。
