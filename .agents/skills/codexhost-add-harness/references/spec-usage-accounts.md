# 用量与账号：会话用量、请求级计量、全局统计、额度

对应能力总表：B13–B14、C7–C8。类型：`packages/harness-adapter/src/usage.ts`（`HostUsage`、`HostUsageRequest`、`parseHostUsage`、`parseHostUsageRequest`）、`usage-statistics.ts`、`account-credits.ts`；schema：`packages/shared-contracts/src/thread-usage.ts`、`harness-accounts.ts`、`account-credits-presentation.ts`。产品口径见 `docs/product/usage-metering.md`、`usage-statistics.md`。

核心原则：**宁可不显示，也不显示错的数字**。未知就是未知（字段省略或 null），不能当作 0。

## 会话用量快照

接口：`session.initialUsage`、`session.usage.changed { usage, observedForTurnId? }`、可选的 `session.refreshUsage()`。

- `HostUsage` 是 Session 级别的**完整**快照，不是字段补丁。Token、上下文窗口、套餐百分比、原生费用（`totalCostUsd`）、原生 Credits（`totalCredits`）都由 Adapter 按原生数据上报。
- 输入 Token 的口径**包含**缓存读写，输出 Token 包含推理 Token；缓存字段缺失表示未知。
- `hostDerivedUsageFields`（`sessionCacheHitRatePercent`、`timeToFirstOutputMs`、`costSource`、`unpricedModels`）只能由 Host 生成，Adapter 填写了也会被剥离。
- `refreshUsage()` 主动查询可靠的统计并发布完整的 Usage；采集失败默认不能让正常的 Turn 失败。
- 用 `parseHostUsage()` 校验后再发布。

## 请求级计量

接口：`usage.request { request: HostUsageRequest }` 和 `usage.history { complete }` 事件。提供后，Host 统一计算会话费用（按公开价格表）、平均缓存命中率、输出速度（TPS）和首 token 时间（TTFT）。

- 每次 open 后，先把原生历史中的全部请求以 `historical: true` 回放一遍，再发送 `usage.history { complete }` 说明历史是否完整。第一次收到 `usage.history` 时，该 Thread 切换为 Host 计量。
- 运行中每完成一次模型请求，发送一条 `usage.request`；某次请求的用量缺失时，发送 `usage.history { complete: false }`。
- `requestId` 在原生 Session 内稳定（例如原生消息 ID），保证重放和重复通知时不重复计费。
- `model` 是**实际使用的原生 Model ID**，不能是 UI 别名或 `HarnessModelRef` 的编码；`provider` 填写标准的 models.dev Provider ID，自定义别名则省略。
- `startedAtMs` / `completedAtMs` 要么同时提供，要么都不提供：从首个输出 token 到请求完成，不含预填充和工具执行。
- 请求的模型在价格表（`packages/host-runtime/src/model-prices.generated.ts`，可被用户的 `pricing.json` 覆盖）里查不到时，费用显示为下限；不要在插件里内置价格。

已接入的有 Pi、OMP、OpenCode v2、Claude Code、DSH、CodeBuddy、WorkBuddy、ZCode，可作为参考。新接入后要更新 `docs/product/usage-metering.md` 的「已接入」列表。

## 全局用量统计

接口：`adapter.usageStatistics: HarnessUsageStatisticsCapability`（`listSources`、`readSource`、可选的 `readModelLabels`）。

- 只读插件自己的本地存储：**不启动进程、不打开 Session、不写原生存储**。
- `listSources` 返回存储单元及其指纹，指纹的计算不能读取文件内容；内容可能变化时，指纹必须跟着变。
- `readSource` 返回 `HarnessUsageEntry[]`，口径与 `HostUsageRequest` 相同。entry `id` 在 Harness 内唯一，Fork 复制出的同一请求保留相同 ID。原生记录了费用时填写 `costUsd`；只有请求、没有 Token 数时设置 `tokensUnknown: true`；`credits` 是原生单位，不换算成美元。
- 响应 `AbortSignal`；单个来源失败不能导致丢失其他用量。

## 账号额度与 Credits

| 接口 | 语义 |
|---|---|
| `inspectAccount(): HarnessAccountSnapshot \| null` | 设置页的**新鲜**只读查询；没有真实额度时返回 null |
| `inspectAccounts(): HarnessAccountSnapshot[]` | 一个 Harness 有多个计费来源时使用；Host 优先调用它 |
| `credits(): AccountCreditsSnapshot \| null` | 同步、无 I/O 地读取账号级缓存，供会话浮窗使用 |
| `refreshCredits(): Promise<…>` | 尽力刷新同一份缓存；Host 不等待、会隔离异常 |

必须：

- 返回当前原生认证对应的账号额度；**不能**把会话花费当成额度，不能返回旧认证的缓存，不能为了查询额度发起模型 Turn。
- 限制查询耗时，并在 close 时释放检查资源。缓存的有效期、并发合并和失效策略由插件负责。
- 额度窗口用 `scope: { id, label, localizations? }` 和 `periodType` 表达范围和周期，不让客户端解析「7-day」之类的字符串。
- 用 `parseHarnessAccountCredits()` 去掉私有的 `fetchedAt` 字段。

参考：Claude Code、Grok、Antigravity 同时实现了 inspectAccount 和 credits；Pi、Kimi、Cursor、Qoder 只实现了 inspectAccount。

## 验收

- 快照：初始值、刷新、通知都正确；未知字段被省略；换 Thread 或 Host 后不残留上一个实例的数据。
- 请求级计量：重放后 `complete` 的值正确；重复通知不重复计费；中途换模型时按实际模型计价；请求缺失时不显示完整费用。
- 统计：不启动进程；指纹变化时重新读取；Fork 中的重复 ID 不被重复计算；取消信号生效。
- 额度：无数据时返回 null；超时被隔离；不触发 Turn；切换账号后不返回旧数据。
