## Context

Desktop renderer（26.901.51231 / build 8109）的行为：`/goal <text>` → `thread/goal/set {objective, status:"active"}` 后本地合成一条 `/goal <objective>` 记录并期待服务端自行起 Turn（原生续跑 Turn 的 `params.input` 为空）；`thread/resume` 后调 `thread/goal/get` 补水；用户中断时先 `set {status:"paused"}`（500ms 超时）再 `turn/interrupt`；"Resume goal" 发 `set {status:"active"}`；收到 `updated {status:"complete"}` 显示 "Goal achieved" 后自己发 `thread/goal/clear`；`blocked` 显示 "Goal stalled" 与 Resume。

Claude Code 2.1.263 / Agent SDK 0.3.220 spike 结论（真实二进制，`pathToClaudeCodeExecutable` 指向用户安装）：

- `/goal <cond>` 的本地输出是 `model: "<synthetic>"` 的 Assistant 消息 `Goal set: …`，随后模型在同一 query loop 内工作；整个 Goal loop 只有一个 `result`。
- 纯文本本地命令（裸 `/goal`、`/goal clear`）同样发 `result`（`num_turns: 0`）。
- SDK 宿主收不到 `active_goal`：CLI 仅在 `CLAUDE_CODE_REMOTE` 下发送，headless 输出白名单排除了它。
- 达成 / 不可能 / 清除只体现在 transcript 的 `attachment.goal_status`（设置与清除 sentinel、每轮判定、`met: true`、`failed: true`）。
- 中断不清除 Goal；Goal 跨进程 resume 保留；不可恢复错误发 `system/informational` 警告。

## Goals / Non-Goals

- Goals：让 Desktop `/goal` 对 Claude Code 线程可用且语义忠实于 Claude 的原生 Goal；机制通用，按能力开放。
- Non-Goals：Host 侧续跑循环、`update_goal` 之类的 Host 工具、token 预算强制、mapping-store 持久化、Renderer 改动。

## Decisions

- **能力形态**：`HarnessSession.goal?: HarnessGoalCapability` + `session.goal.changed`，而非 `execute` 新命令；避免修改全部 Session 实现（含 Broker 代理），与 `commands?` 精确对齐。
- **goal.set 起 Turn**：Harness 自行开始 Goal Turn，Host 投影空输入 Turn；Claude Adapter 在 `Goal set:` 确认前缓冲事件，拒绝时静默撤回，保证 Host 在失败路径上没有见过该 Turn。
- **终态来源**：Turn 结束后 Adapter 读 transcript `goal_status` 对账（250ms 后重试一次）；`goal.read()` 同源，供 resume 后补水。
- **不持久化**：原生 transcript 是事实源；Host 只在内存中保留 `paused`、预算与 `tokensAtStart`，`thread/goal/get` 首次访问时补水。
- **状态映射**：achieved → complete，unachievable / error → blocked，cleared → cleared；Goal Turn failed → blocked，cancelled → paused；`paused` 仅 Host 侧；Resume 重新 `goal.set`。
- **忙碌处理**：objective 变更需空闲（`-32072`），Desktop 自己会先 pause+interrupt；`paused` 不受忙碌限制。

## Risks / Trade-offs

- transcript 写入晚于 `result` 时，Host 会短暂保持 `active`；一次重试覆盖常见延迟。
- `tokenBudget` 只回显不强制。
