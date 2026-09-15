# 外部 Thread 的 Goal

Codex Desktop 的 `/goal` 输入框和「Pursuing goal / Goal achieved / Goal stalled」状态条通过 app-server 方法 `thread/goal/set`、`thread/goal/get`、`thread/goal/clear` 与通知 `thread/goal/updated`、`thread/goal/cleared` 工作。codexhost 之前对外部 Thread 一律返回 `-32076`，Desktop 因此提示 "Failed to set goal"，并在每次 `thread/resume` 后记录 "Failed to hydrate thread goal"。

codexhost 把这组方法**桥接到 Harness 自己的 Goal**，不在 Host 侧自造续跑循环：Harness 拥有 Goal 是否存在、如何评估、何时结束；Host 只补足 Desktop 需要而 Harness 没有原生表示的状态（`paused`、token 预算与用量基线），并把原生证据投影成 Codex 的 `ThreadGoal`。

## 所有权与契约

- `HarnessSession.goal?: HarnessGoalCapability`（`set` / `clear` / `read`）与 `session.goal.changed` 事件是唯一的公共契约，形态与 `commands?` 一致：没有原生 Goal 的 Harness 不暴露它，Host 对其 `thread/goal/set|clear` 返回 `-32078`，`thread/goal/get` 返回 `{goal: null}`。
- `goal.set({turnId, objective})` 由 Harness 以自己的方式开始 Goal 的第一个 Turn 并复用普通 Turn 生命周期；objective 不是可见的用户输入，Host 投影的 Turn 没有 `userMessage`（Desktop 已在本地合成 `/goal <objective>` 记录，与原生 Codex 的续跑 Turn 一致）。
- `goal.read()` 只读原生证据，不启动进程；`goal.clear()` 是静默原生操作，不向 Host 投影 Turn。
- `session.goal.changed` 携带 Harness 中立的 `HostGoal`（objective、setAtMs）；`goal: null` 时用 `outcome` 说明去向：`achieved` / `unachievable` / `cleared` / `error`。

## Host 状态映射

| Desktop 请求 | Host 处理 |
|---|---|
| `set{objective}`，线程空闲 | 调 `goal.set` 起 Turn；状态 `active`；同 objective 保留 `createdAt`；`tokensAtStart` 取会话累计 token；回 `{goal}` 后发 `thread/goal/updated`（带 `turnId`）。 |
| `set{objective}`，线程忙（运行中 / steering / command） | `-32072`。Desktop 自己会先 pause 再 interrupt。 |
| `set{status:"paused"}` | 仅 Host 侧，不调 Harness、不等待 Turn（Desktop 在 interrupt 前用 500ms 预算发送它）。 |
| `set{status:"active"}` 无 objective（Resume） | 需已有 Goal；空闲 → 用存储的 objective 重新 `goal.set`（Harness 重新注册并开始工作）；运行中 → 仅改状态。 |
| `set{tokenBudget}` | 存储并回显，不强制（Harness 无预算概念）。 |
| 其它 status、`objective:null`、空参数 | `-32602`。 |
| `clear` | 无 Goal → `{cleared:false}`；Harness 已自行放弃（`nativeCleared`）→ 直接删并发 `thread/goal/cleared`，不再调 Harness；运行中 → `-32072`；否则 `goal.clear()`。 |

Harness 事件到 Desktop 状态：`goal` 非空 → `active`（若 Host 为 `paused` 且有 Turn 在跑则视为已恢复）；`achieved` → `complete`（Desktop 显示 "Goal achieved" 后自己发 `thread/goal/clear`）；`unachievable` / `error` → `blocked`（Desktop 显示 "Goal stalled"，Resume 会重新注册）；`cleared` → `thread/goal/cleared`。Goal Turn 以失败结束 → `blocked`；被取消 → `paused`；成功结束不改状态，以 Harness 的评估结论为准。

`tokensUsed = 会话累计 token − tokensAtStart`，`timeUsedSeconds` 自 `createdAt` 起计（含 paused 时段）。Host 不持久化 Goal：`thread/goal/get` 首次访问时通过 `goal.read()` 从原生证据补水；恢复出的 Goal 先显示为 `paused`，由用户 Resume 后重新交给 Harness 执行，之后由 `session.goal.changed` 纠偏。

## Claude Code 接入

Claude Code 2.1.139+ 自带 `/goal`：设置后立即以条件为指令开始 Turn，每个 Turn 结束由 Stop hook 评估器（Haiku）判定，未达成则在**同一个 query loop** 内继续，直到达成、判定不可能、无进展熔断或用户中断；中断不清除 Goal，下一条 prompt 后评估恢复；Goal 跨进程 resume 保留。

Agent SDK 宿主拿不到 `active_goal` 帧（CLI 只在 `CLAUDE_CODE_REMOTE` 下发送，headless 输出过滤了它），Adapter 因此从以下原生证据推导：

- `/goal` 本地命令输出：`model: "<synthetic>"` 的 Assistant 消息，文本为 `Goal set: …` / `Goal cleared: …` / `No goal set` / `Goal active: …` / `Goal condition is limited to 4000 characters …` / `/goal is only available in trusted workspaces…` / `/goal can't run while hooks are restricted…`。
- 不可恢复错误：`system/informational` 的 `Goal cleared after an unrecoverable error (…)`。
- 终态：会话 transcript 中的 `attachment.goal_status` 记录（设置 / 清除 sentinel、`met: true` 达成、`failed: true` 不可能）。Turn 结束后 Adapter 通过有界退避读取这些记录，`goal.read()` 也由此回答 resume 后的状态。

`goal.set` 发送 `/goal <objective>`，在收到 `Goal set:` 之前缓冲全部 Turn 事件：被 Claude 拒绝时整个 Turn 静默撤回，Host 不会看到任何事件；确认后再依次发出 `turn.started`、缓冲事件和 `session.goal.changed`。`goal.clear` 发送 `/goal clear`，只等待本地命令回执，不投影 Turn。历史读取把 `/goal <args>` 显示为 `/goal <args>`，把状态查询和 clear 记录当作控制记录隐藏。

### 当前兼容边界

- 依据 Codex Desktop **26.901.51231 / build 8109** 的 renderer（`thread/goal/*` 调用、resume 后补水、中断前 pause、achieved 后自动 clear）和 Claude Code **2.1.263** / Agent SDK **0.3.220** 的输出形态。更新任一方后需重新核实这些文本与消息形态。
- Claude 的 `/goal` 受工作区信任和 hooks 设置约束；被拒绝时 `thread/goal/set` 以 `-32602`（超长）或 `-32073`（其它原生拒绝）失败。
- 达成与不可能只能在 transcript 里区分；若 transcript 尚未写入，Host 会短暂保持 `active`，直到下一次原生证据到达。
- `tokenBudget` 只存储不强制；DeepSeek Harness 的 `/dsh-goal` 与本机制无关。

## 验证

- `packages/adapters/claude-code/test/claude-goal.test.ts`：信号解析、命令输出分类、transcript 推导与状态机。
- `packages/adapters/claude-code/test/claude-code-adapter.test.ts`：确认后才起 Turn、拒绝时静默撤回、静默 clear、transcript 补水。
- `packages/adapters/claude-code/test/claude-history.test.ts`：`/goal` 记录的历史显示与隐藏。
- `packages/host-runtime/test/app-server-host.test.ts`：Desktop 路由、状态映射、失败 → blocked、Resume 重注册、achieved 后 clear 不再调 Harness、无能力 Harness 的拒绝。

实现前用 Agent SDK 对真实 Claude Code 2.1.263 做了 spike（设置多轮 Goal、不可能 Goal、`/goal clear`、中断、resume），上述文本与消息形态来自该记录。该 spike 和合成测试不替代真实 Desktop 验收：发布前应在 Desktop 中对 Claude 线程执行 `/goal`，观察 "Pursuing goal"、达成后的 "Goal achieved" 与自动清除、中断 → paused → Resume，以及重启 codexhost 后的状态补水。
