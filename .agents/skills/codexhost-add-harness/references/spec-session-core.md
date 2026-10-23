# 会话核心：inspect、open、execute、配置、错误、关闭

对应能力总表：A3–A4、A9–A10、B1–B4。签名以 `packages/harness-adapter/src/text-session.ts` 为准；校验工具从 `packages/harness-adapter/src/index.ts` 获取，不在插件里复制公共接口或 schema。

## 核心对象

| 对象 | 必须 | 不支持某项能力时 |
|---|---|---|
| Adapter | 稳定的 `harnessId`；`inspect`、`open`、整体 `close` | 可预期的检查失败用 inspection 状态表示；打开失败返回 `HarnessResult` |
| Session | 真实的 `capabilities`、`initialState`、`initialUsage`、有序 `outputs`、`execute`、只读 `readSnapshot`、`close` | 公共方法都要保留；具体不支持的操作返回 `unsupported` |
| 原生配置 | 按能力支持 Model、Thinking、Permission Mode | 对应能力声明为 false；不填写虚构的 Catalog 或 effective 值 |
| 可选接口 | 见本页末尾和其他规范 | 不提供无意义的空接口 |

原生具有工具、交互或自主执行等能力时，要映射其真实行为，不能为了少做工作降级为纯文本回显。类型中没有 capability 字段的能力，也必须在 `CAPABILITIES.md` 中说明。

## 检查（inspect）

接口：`inspect({ cwd?, refresh?, purpose? })` → `HarnessInspection`（`packages/shared-contracts/src/harness-models.ts`）。

必须：

- 检查安装、认证、可用性、Catalog 和能力；**不创建用户 Session、不提交 Prompt**。
- 尊重 `cwd`。成功结果按实际配置作用域缓存，`refresh` 能绕过缓存；检查时临时启动的 Transport 必须关闭。
- `purpose: "availability"`：调用方只关心状态和错误，可以不启动原生 Session 就返回。此时 Catalog 可以省略原生默认 Model 和 Thinking，因此这个结果不能当作完整检查使用。参考 OMP（#577）。
- 可预期的失败返回 `notInstalled`、`unavailable` 或 `error`，不用任意抛异常代替。
- ready 结果通过 `harnessInspectionSchema` 校验；`permissionModes` 是否存在必须与 `selectPermissionMode` 一致，schema 会强制检查。
- Model Ref 保留原生 Provider/Model 身份，但对 Host 保持 opaque，并符合 transport-safe schema。
- Catalog 引用、默认值、每个 Model 的 Thinking 选项相互一致。固定模型或空目录按实际情况表达，不为迎合 UI 伪造可选模型。

禁止：在 inspect 中写原生会话、触发登录流程、启动长期驻留进程却不关闭。

验收：第二次调用命中缓存；`refresh` 后重新读取；未安装、未登录、协议不兼容分别返回不同状态；没有残留子进程。

## 打开（open）

接口：`open(input: OpenSessionInput)`，有四个分支：`create`、`resume`、`fork`、`rollbackLastTurn`。身份与历史的要求见[身份与历史](spec-history.md)。

必须：

- 校验 `cwd`、输入，以及 Native Ref 是否属于本 Harness；不支持的分支要在产生副作用之前拒绝。
- **所有实际打开路径都传播 `input.environment`**，包括 resume 和支持的派生操作。工厂环境是基础环境，Session 环境承载本次 Thread 的覆盖值，不能被基础环境反向覆盖。
- 可预期的失败返回类型化结果，并清理新建的连接、订阅和临时资源。源历史和 Host 映射事务不由插件擅自修改。
- 返回的 Session 必须可以执行。只读的原生 Subagent Transcript 不应冒充普通可写 Session。
- `create` 可能是 Desktop 预热（见[预热与空闲释放](spec-prewarm-idle.md#预热)）：在第一次 `turn.start` 之前不能提交用户可见内容，也不能在原生侧产生需要用户清理的空会话。

### 执行意图与权限

`create.executionPolicy` 是 Host 的执行意图，不是原生 Permission Mode。对于 `unattended-full-access`，按以下顺序处理：

1. 原生可以配置：映射为等价的权限、沙箱和交互策略，并确认生效。
2. 已验证的原生默认行为天然满足：可以有测试依据地不做任何事。例如 Pi 没有对应权限参数，就不传。
3. 无法保证：类型化拒绝。不静默忽略，也不伪造审批回答。例如 Cursor 无法确认 `--force` 最终是否生效，因此返回 `unsupported`。

`permissionModeScope: "atCreate"` 表示只能在创建时选择（参考 Grok）；Session 中途的切换必须明确拒绝。`live` 表示运行中也可以切换。显式指定的权限模式与无人值守意图冲突时（例如 Qoder 的非 bypass 模式），拒绝创建。

## 配置与状态：requested 不等于 effective

- `initialState`、`session.state.changed` 和快照中的 state 只报告**原生已确认**的状态。原生身份可以延迟发布，建立后在同一个公共 Session 内保持不变。
- 未指定 Model 或 Thinking 时保持省略，让原生配置决定默认值，不用 Renderer 的偏好代填。
- 配置写入要等待原生确认，成功后才返回 completed 并发布状态；确认失败时不发布 requested 值。
- 切换 Model 可能同时改变 Thinking，要用完整、一致的状态更新。原生按 Model 动态提供 Thinking 列表时，写入 `state.availableThinkingOptions`；切换 Model 时整体替换列表，不重放旧的 Thinking 值（参考 Kimi）。
- `resolvedModelLabel` 只用于展示原生解析出的实际模型名，不能代替 `effectiveModel`。
- **运行中切换**：活动 Turn 期间的 `model.select` / `thinking.select` 不能仅因为有活动 Turn 就拒绝，规则见 `docs/architecture/harness-plugin-runtime.md#运行中切换-model--thinking`。
- 原生需要重启 Transport 才能改配置时，要验证身份不变、失败后能恢复、订阅已重建、旧资源已关闭（参考 OMP，不照搬其私有协议）。

resume 时的配置提示规则见[身份与历史](spec-history.md#resume)。

## 命令、并发与错误

必须：

- `turn.start` 成功只表示已接受，终态从 outputs 获取；被拒绝时不发送任何 Turn 生命周期事件。
- 活动 Turn 与第二个 Turn、历史操作互斥；冲突时返回可重试的 `sessionBusy`，不隐式排队，也不抢占。
- `interaction.respond` 必须能在所属 Turn 中执行。
- 校验空输入、Turn ID、Interaction ID 和配置引用；取消只作用于匹配的活动 Turn。
- close 或 fault 之后返回 `invalidState`；取消完成后仍可继续使用的 Session 不能被误判为 fault。
- 原生错误归一化为 `HarnessError`，`code` 取 `HarnessErrorCode` 中的值：`notInstalled`、`authenticationRequired`、`configurationRequired`、`sessionNotFound`、`checkpointNotFound`、`protocolError`、`processExited`、`nativeFailure` 等，并合理设置 `retryable`。
- 用 `sanitizeDiagnosticTail` 等公共诊断工具清理输出；错误、日志、Ref、路由和测试产物中不能出现凭据。工厂 Context 本身不负责过滤凭据。
- Adapter 和 Session 的 `close` 都必须幂等：结束 outputs，关闭进程、流、连接、订阅和定时器；关闭一个实例不影响同一连接上的其他实例。

验收：成功、拒绝、忙碌、取消、关闭后调用、原生进程意外退出这几条路径都有测试；关闭后没有残留资源。

## 可选接口一览

| 接口 | 规范 |
|---|---|
| `session.refreshUsage()`、`usage.*` 事件、`usageStatistics`、`inspectAccount(s)`、`credits()` | [用量与账号](spec-usage-accounts.md) |
| `installation()`、`install()` | [连接页](spec-connections.md) |
| `adapter.subagents.readSnapshot()` | [输出与交互](spec-output-interactions.md#autonomous-turn-与原生-subagent) |
| `adapter.sessionImport` | [身份与历史](spec-history.md#导入) |

## 本页验收

通过公共接口证明以下各点：inspection 没有用户会话副作用；输入与能力校验真实生效；创建、后续 Turn、取消和关闭都可用；每种受支持的配置写入都经过原生确认；Session 环境覆盖正确；失败时没有资源泄漏。不支持和受限的分支也要有拒绝测试，不能只测成功路径。
