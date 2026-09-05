# 公共行为：插件必须履行的运行时契约

所有新插件都读取本页。签名以 `packages/harness-adapter/src/text-session.ts` 为准，校验工具从 `packages/harness-adapter/src/index.ts` 查找；不要在插件中复制公共接口或 schema。

## 核心实现与可选能力

| 对象 | 核心职责 | 不支持时的处理 |
|---|---|---|
| Adapter | 稳定 `harnessId`；inspect、open、整体 close | 预期检查失败使用 inspection 状态，打开失败使用 `HarnessResult` |
| Session | 真实能力、初始状态/Usage、有序 outputs、execute、只读快照、close | 保留公共方法，具体不支持的操作返回 `unsupported` |
| 原生配置 | 按能力支持 Model、Thinking、Permission Mode | 能力为 false；不填虚构 Catalog 或 effective 值 |
| 历史派生 | 按能力支持 Fork、跨 cwd Fork、Rollback | 对应 history 能力为 false，打开分支返回 `unsupported` |
| 可选接口 | 见本页末尾 | 不提供无意义的空接口 |

原生具有工具、交互或自主执行等目标能力时，要映射其真实行为，不能为缩小工作量降成纯文本回显。类型中没有 capability 字段的能力，也必须在交付能力清单中说明。

## 检查：`inspect({ cwd, refresh })`

- 检查安装、认证、可用性、Catalog 和能力，不创建用户 Session、不提交 Prompt。
- 尊重 cwd；成功缓存按实际配置作用域划分，refresh 能绕过缓存；临时检查 Transport 必须关闭。
- 预期失败返回 `notInstalled`、`unavailable` 或 `error`，不用任意异常代替。
- ready 结果通过 `harnessInspectionSchema`；Permission Mode Catalog 与 `selectPermissionMode` 一致。
- Model Ref 保留原生 Provider/Model 身份，但对 Host 保持 opaque；符合共享的 transport-safe schema。
- Catalog 引用、默认值、每个 Model 的 Thinking 选项相互一致。固定模型或空目录按实际能力表达，不伪造可选模型满足 UI。

参考 `packages/shared-contracts/src/harness-models.ts`；涉及权限时还读取 `packages/shared-contracts/src/harness-permission-modes.ts`。

## 打开：`open(input)`

识别所有 `OpenSessionInput` 分支；具体身份与历史要求见[身份与历史](thread-lifecycle-and-history.md)。

- 校验 cwd、输入和 Native Ref 所属 Harness；不支持的分支在产生副作用前拒绝。
- 所有实际打开路径都传播 `input.environment`，包括 resume 和支持的派生操作。工厂环境是基础环境，Session 环境承载本次 Thread 的覆盖值，不能被基础环境反向覆盖。
- 预期失败返回类型化结果；失败清理新建连接、订阅、临时资源。源历史和 Host 映射事务不由插件擅自修改。
- 返回 Session 必须仍可执行；只读原生 Subagent Transcript 不应冒充普通可写 Session。

### 执行意图与权限

`create.executionPolicy` 是 Host 的执行意图，不是原生 Permission Mode。对于 `unattended-full-access`：

1. 原生可配置：映射为等价权限/沙箱/交互策略，确认成功。
2. 已验证的原生基线天然满足：允许有测试依据的 deliberate no-op，例如不向 Pi 传不存在的权限参数。
3. 无法保证：类型化拒绝，不静默忽略，不伪造审批回答。

`permissionModeScope: "atCreate"` 表示只能在创建时选择。`selectPermissionMode` 为 true 不等于必然支持 live 切换；Session 中不支持的切换仍明确拒绝。参考 Grok 的创建期权限，但不要复制其 Host 恢复特例。

## 配置与状态：requested 不等于 effective

- `initialState`、`session.state.changed` 和快照 state 只报告已确认原生状态。
- 原生身份可延迟发布，建立后在同一公共 Session 内保持稳定。
- 未指定 Model/Thinking 时保留省略，让原生配置决定默认值；不能取 Renderer 偏好代填。
- 配置写入等待原生确认，成功后才返回 completed 并发布状态；确认失败不发布 requested 值。
- Model 切换可能同时改变 Thinking；用完整一致状态更新。状态/Usage 事件不是未声明的字段 patch。
- 恢复时区分“这次没有读到配置”和“已确认该配置不存在”，避免从旧持久化值复活已清除的 Thinking/权限。
- 原生若需重启 Transport 才能配置，验证同一身份、失败恢复、订阅重建和资源关闭；参考 OMP，但不照搬其私有协议。

## 命令、并发与错误

- `turn.start` 成功仅表示接受，终态从 outputs 获取；拒绝时不能发 Turn 生命周期事件。
- 活动 Turn 与第二个 Turn、Model/Thinking 写入、历史操作互斥；冲突返回可重试 `sessionBusy`，不隐式排队或抢占。
- `interaction.respond` 必须可在所属 Turn 中执行。权限是否支持活动期修改取决于原生语义，仍需控制配置并发。
- 校验空输入、Turn ID、Interaction ID、配置引用；取消只针对匹配的活动 Turn。
- 关闭或 fault 后返回 `invalidState`；取消完成后仍可继续的 Session 不应被误当作 fault。
- 原生错误归一化为 `HarnessError`：区别未安装、认证、会话不存在、协议错误、进程退出与操作失败；合理设置 retryable。
- 使用公共诊断清理能力；错误、日志、Ref、路由和测试产物中不暴露凭据。工厂 Context 本身不是凭据过滤器。

事件顺序与关闭终态见[输出与交互](output-and-interactions.md)。Adapter 和 Session 的 close 都必须幂等，且结束 outputs、关闭进程/流/连接/订阅/定时器；关闭一个实例不能影响其他连接的独立实例。

## 按原生能力提供的可选接口

| 接口 | 实现要求 | 当前上层边界 |
|---|---|---|
| `session.refreshUsage()` | 主动查询可靠统计并发布完整 Usage；未知是 null，采集失败不默认使正常 Turn 失败 | 通过公共 Usage 路径验证初始值、刷新和通知 |
| `session.commands` | 校验 Catalog 和参数，以 Host 的 turnId 走正常 Turn/Item 输出；未知命令拒绝 | 如 compact，复用公共命令 UI |
| `adapter.subagents.readSnapshot()` | 稳定原生 Subagent 身份、只读 Transcript；与能力声明一致 | 不等同于跨 Harness 委派 |
| `adapter.sessionImport.listCandidates()` / `resolveCandidate(id)` | list 返回浏览器安全元数据；resolve 重新校验并返回 `{ candidate, nativeRef }`，完整 locator 由 Adapter 确认；不写 Host 映射库 | 本地 Host/RPC/设置页已通用化，Pi 与 DSH Modern 已接入；仅有 list 的旧插件不进入可导入目录。远程与 CC Broker 尚未扩展 |
| `adapter.webUi.open()` | inspection 的 webUi 与动作一致；本地打开优先使用 Context 服务 | managed remote 无本地 opener，缺服务时明确不可用，不绕过 Native Launcher |

相关 schema：`packages/shared-contracts/src/harness-commands.ts`、`harness-session-import.ts`、`thread-usage.ts`；Usage 解析用 `parseHostUsage()`。导入契约、未知运行状态与接入验收见 [`docs/harness-session-import.md`](../../../../docs/harness-session-import.md)。

**Credits 尚不是正式 Adapter 字段。**现有 Host 通过 `credits()` / `refreshCredits()` 结构检查处理，并有 Renderer 等特例。新 Harness 需要额度展示时，单独核对公共扩展和上层使用方；不要在 Manifest 虚构 capability 或承诺自动接入。

## 本页验收

通过公共接口证明：inspection 无用户会话副作用；输入/能力校验真实；创建、后续 Turn、取消和关闭可用；每种受支持配置写入由原生确认；Session 环境覆盖正确；失败无资源泄漏。为不支持和受限分支添加拒绝测试，而不只测试成功路径。

## `close()` 契约

所有 `HarnessSession.close()` 在 Promise resolve 时都必须满足：

- `outputs` 已结束，并且 close 前已经发出的值会在结束前可被消费；
- 后续不能再接受命令或产生输出；
- Adapter 控制的 Transport、订阅、定时器和其他资源已经释放；
- 重复调用安全。

只有 `capabilities.history.replacementFence === true` 时，`close()` resolve 还必须证明该 Session 启动或控制的原生工作已经停止，并且不会继续修改 Native Transcript 或 Workspace。Host 才能在历史替换提交前用 `close()` 隔离旧 Session，并排空其输出。CLI/RPC Harness 通常需要等待子进程树退出；独立 Server Harness 需要停止订阅和它为该 Session 启动的 Server。仅断开一个仍可自主执行的监听器不满足 fence 契约。

`replacementFence` 是可选字段，遗漏与 `false` 等价；未声明 Rollback 的旧 Adapter 仍可直接解析，旧的 Rollback-capable Adapter 则必须显式迁移并证明 fence，否则按不兼容能力 fail closed。普通 `close()` 的资源和输出保证不能被推断为 native/workspace fence。

Session 的 `capabilities` 在其生命周期内必须保持不变。Host 会在候选 Session 打开时以及配置/历史异步校验完成后的提交边界重复检查 `replacementFence`；如果能力声明发生变化，替换会在关闭来源 Session 或写 Store 前失败。


## 活动 Turn 输入

`activeTurns.steer=true` 才能接受 `turn.steer`。输入继续归入当前 Host Turn；多个 admission 串行，与取消和完成收敛。带 `clientUserMessageId` 的重复请求须幂等，相同身份但不同输入拒绝。具体契约以 `text-session.ts` 和共享能力 schema 为准。
