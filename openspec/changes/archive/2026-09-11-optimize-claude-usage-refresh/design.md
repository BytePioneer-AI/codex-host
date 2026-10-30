## Context

Issue #50 的根因不是单次 `getContextUsage()` 本身，而是生命周期触发频率与单次调用放大效应叠加：Claude Code Adapter 当前在每个完整 Assistant、每个本地 Tool 完成和 Turn terminal 后刷新 Context；一次稳定 Context 操作会在 Claude Code 内部展开成多次远程 `count_tokens`，而成功分支没有结束重试循环，进一步放大请求量。

与此同时，Claude SDK 的正常 Assistant 响应已经携带请求级 Usage，Turn Result 还携带累计 `total_cost_usd` 与按实际 Model 划分的 `modelUsage`。这些原生事件足以在长 Turn 内持续展示最新 cache hit、Token 和费用估算，无需为了每次 UI 更新主动调用计数端点。

本变更跨越 Claude 私有 Transport、Adapter Session、Host inspection 与 Renderer 交互，但必须保持以下边界：

- Claude SDK payload、Model/Provider 细节和计价逻辑留在 Claude Adapter 内。
- Host 只持有每个 Thread 的最新规范化 `HostUsage`，不维护第二条 Usage ledger。
- Mapping Store 不写入 Usage、费用、请求 ID 或 Context 缓存。
- 账号级 5 小时/7 天额度可由 Claude Adapter 共享；Session Usage 不得共享。
- Usage 失败始终是可忽略的 Telemetry 失败，不改变 Turn 或 Session 生命周期。

## Goals / Non-Goals

**Goals:**

- 消除 Assistant、Tool 和普通 Turn terminal 自动触发的重量级 Context 请求。
- 在每次完整原生模型响应后更新最新 cache hit、上下文近似值和当前 Session 费用估算。
- 使用响应的实际 Model/Provider 归属进行请求费用估算，并用 Turn Result 的累计事实校准。
- 为用户主动打开或刷新详情提供合并并发、短 TTL、失败冷却且可丢弃过期结果的精确 Context 读取。
- 保证多个并发 Claude Session 的请求去重、估算、Context 缓存和最终校准相互隔离。
- 保持现有 `HostUsage`、Popover 与原生 Codex context carrier 的兼容投影。

**Non-Goals:**

- 不持久化或重建 Session Usage、费用估算、请求 ID、Context 缓存或历史时间线。
- 不调用 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` 获取 Session totals 或套餐额度。
- 不读取 OAuth 凭据，也不直接请求 Anthropic `/api/oauth/usage`。
- 不在本地 Tool completion 上制造 Token、费用或 Context 变化。
- 不允许活动 Turn 中切换 Model；现有 Idle-only Model selection 保持不变。
- 不展示 Claude Session 累计 cache read/write、Reasoning Token，也不修改 Grok `accountCredits` 所有权。
- 不改变 Mapping Store、Protocol Core context circle carrier 或 Native Transcript 投影。

## Decisions

### 1. 正常渲染采用被动请求级 Usage，精确 Context 仅按需读取

每个 Root Assistant `message.completed` 都携带一份规范化请求观测。Adapter 立即用它更新：

- 最新请求 cache hit rate；
- 当前请求结束后的 context used 近似下界；
- 活动 Turn 已完成请求的 input/output 与费用估算；
- 合并后的 Session Usage 快照。

Tool completion 不触发任何 Usage 请求，因为本地 Tool 执行本身没有新的模型计费事实。Turn terminal 也不再自动调用 Context；它只消费 Result 进行校准。

精确 `getContextUsage()` 只服务显式详情读取/刷新及少数独立校准场景（例如成功 Compaction 后用户主动查看）。Renderer inspection 首先返回当前缓存快照；Host 同时请求 Session 执行一次精确刷新，刷新结果仍经 `session.usage.changed` 推送到当前 Thread，避免让首次打开 Popover 阻塞在远程计数上。

**替代方案：** 保留自动 Context 刷新但降低频率。该方案仍让普通对话路径依赖多次远程 `count_tokens`，且 Tool loop 的调用数仍与执行步数增长，因此不采用。

### 2. 请求观测必须保留真实归属与稳定身份

`ClaudeLastRequestUsage` 扩展为最小的 Adapter 私有请求观测：

- `requestId`：优先使用原生 Assistant `message.id`，用于每 Session 去重；
- `model`：该请求实际使用的 Model 标识；
- `provider`：仅在 SDK 提供稳定结构化值时保留；
- input、output、cache creation、cache read Token。

`native-message` 从完整 Root Assistant 消息解析这些字段，并把同一 `message.id` 的重复完整 frame 合并为一个请求。若 live frame 缺少 Usage，现有受限 Transcript 补读可作为兼容回退，但补读得到同一 `requestId` 后仍经过同一去重集合。

这些字段不跨出 Claude Adapter 包；Host 和 Renderer 只看到规范化聚合值。

**替代方案：** 用当前 UI 选择的 Model 给所有请求计价。Tool loop、自动降级或跨 Turn Model 变化时会产生错误价格，因此拒绝。

### 3. Session 内维护“已校准基线 + 当前 Turn 请求增量”

每个 `ClaudeHarnessSession` 在内存中维护：

- 最近一次 Result 校准的 Session input/output/cost 基线；
- 当前活动 Turn 已处理的请求 ID 集合；
- 当前 Turn 按实际 Model/Provider 累加的 input/output/cost 增量；
- 最新请求 cache hit 与 context 近似值。

完整 Assistant 到达后，若 `requestId` 尚未计入当前 Turn，则累加一次并发布 `baseline + active delta`。Turn Result 到达后，若 `modelUsage`/`total_cost_usd` 有效，则用 Result 的累计值替换临时值，并清空该 Turn 的估算增量。Result 缺少某个字段时保留该字段的已知估算，不用零覆盖。

成本估算采用 Claude Adapter 内的版本化价格解析，按请求实际 Model/Provider 选择可靠价目；无法可靠定价的请求只更新 Token 和 CH，不增加费用。最终 `total_cost_usd` 始终优先于本地估算。

该状态按 Session 实例所有，Session A 的请求 ID、增量和 Result 不能写入 Session B。Adapter 级只共享 plan-limit cache。

**替代方案：** 仅等待 Result 再更新费用。实现简单但长 Tool Turn 数分钟内无反馈，不满足近实时目标。

### 4. Context 近似值与精确值具有不同新鲜度

请求级 prompt Token 可作为当前 Context used 的近似下界，但不能冒充精确计数：

- 若已有可靠 `contextWindowTokens`，请求完成时可发布近似 `contextUsedTokens`；
- 精确读取成功后替换近似 pair，并记录精确观测时间；
- Compaction 或 effective Model generation 改变时使旧 Context pair 失效，必要时发布移除该 pair 后仍有效的其它 Session Usage；
- Renderer 详情文案继续展示 Context，不新增另一套持久状态或历史字段。

为了不扩大通用契约，精确/近似标记留在 Session 私有缓存中，不加入 `HostUsage`。用户显式刷新后的值才作为新的精确缓存。

### 5. 精确刷新采用 Session 级 single-flight、TTL、冷却与 generation 门禁

每个 Session 只有一个 Context refresh owner：

- **single-flight**：同一 Session 的并发详情请求共享一个 in-flight Promise；不同 Session 不共享；
- **短 TTL**：最近成功的精确读在短时间内直接复用；
- **失败冷却**：失败后在冷却窗口内不再次访问远程计数；
- **成功即返回**：第一次有效 Context 结果发布后立即结束，不继续后续 retry delay；
- **generation 门禁**：Turn/Model generation、Session replacement、close 或 fault 后返回的旧结果丢弃；
- **有界取消**：close 不等待非必要刷新。

仅 `null`、malformed 或抛错可进入有界重试；重试次数不随 Renderer 重复点击叠加。

**替代方案：** 在 Host 做全局 single-flight。Host 不理解 Native Session/Model generation，且容易错误合并两个 Claude Session，因此由 Adapter Session 所有。

### 6. 显式刷新扩展现有固定 inspection，而不是创建通用查询通道

`codexhost/thread/usage/inspect` 增加一个可选、严格枚举的读取模式，例如 `refresh: "exact"`；省略时只读当前内存快照。Host 解析到 External Claude Thread 后，先返回或保留已有快照，并调用 Harness Session 的可选 Usage refresh capability。刷新结果通过现有有序 `session.usage.changed` 与 `codexhost/thread/usage/updated` 到达 Renderer。

Renderer 在用户打开 Popover 或触发刷新时请求 exact 模式，并继续使用 Thread ID、Composer identity 和单调 generation 拒绝过期结果。普通通知和初始 Composer 绑定不自动请求 exact Context。

该 capability 是 Harness 层最小可选操作；不支持的 Adapter 返回当前缓存/unsupported，不影响现有 Pi、OMP、Grok 行为。

### 7. Result 和 rate-limit 仍是事实校准，但移除实验 Usage 拉取

Turn Result 的 `modelUsage` 与 `total_cost_usd` 是 Session 聚合校准来源；`result.usage` 只代表最近请求。SDK `rate_limit_event` 继续提供可选账号 5h/7d 数据，并由 Adapter 级缓存共享。

删除 Claude Transport 的 `getSessionUsage()` 与实验 `getPlanLimit()` 依赖。账号额度仅被动接收稳定事件；没有事件时省略，不通过凭据或实验控制通道补齐。这样修复 Context 请求风暴的同时，也不会把另一个实验 Usage API 留在普通 Renderer inspection 路径。

## Risks / Trade-offs

- [请求级费用与最终 Result 有短暂偏差] → UI 明确为 estimate；Result 到达后原子校准累计值。
- [SDK 不提供可可靠识别的 Model/Provider] → 仍发布 Token/CH；无法可靠定价时省略该请求费用增量，等待 Result 校准。
- [重复 Assistant frame 导致重复计费] → 每 Session 以稳定 `requestId` 去重，并测试 live + Transcript 回退重复到达。
- [Context 近似值在 Compaction 后过高] → Compaction/Model generation 使精确 pair 失效；下一次显式详情刷新重新校准。
- [用户频繁打开 Popover仍触发远程调用] → Session single-flight、短 TTL 与失败冷却共同限制调用上界。
- [精确刷新完成时用户已切换 Thread] → Adapter generation 与 Renderer request generation 双层丢弃过期结果。
- [移除实验 plan pull 后额度首次出现更慢] → 接受字段可选语义；只在稳定 `rate_limit_event` 到达后显示，不以不稳定 API 换取及时性。
- [HostUsage 无精确度标记] → 精确度仅影响刷新策略，不新增 UI 状态；避免扩大所有 Harness 的公共数据模型。

## Migration Plan

1. 先扩展 Claude 私有请求观测与 parser tests，保留现有发布路径以验证字段正确性。
2. 加入 Session 请求去重、活动 Turn 估算和 Result 校准测试，再切换 `message.completed` 到被动发布。
3. 删除 Tool/Turn 自动 Context 刷新，并修复成功后重试未终止的回归测试。
4. 增加可选 exact inspection/Session refresh capability，接入 TTL、single-flight、冷却和 generation 门禁。
5. Renderer 仅在详情交互时请求 exact refresh，继续立即展示缓存快照。
6. 删除 Claude 实验 Session Usage/plan pull 调用与相应测试，保留 `rate_limit_event` 被动账号额度。
7. 运行 Claude Adapter、Host Runtime、shared contracts 与 Renderer 的聚焦测试；确认 Mapping Store fixture 不出现 usage/cost/context/requestId。

回滚时可恢复旧的缓存-only inspection，并关闭被动费用估算；不得恢复 Tool completion 上的自动 Context 查询。