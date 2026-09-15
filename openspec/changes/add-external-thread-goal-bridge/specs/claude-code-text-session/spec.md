## ADDED Requirements

### Requirement: Claude Code Goal 映射到原生 `/goal`
Claude Code Adapter SHALL 用原生 `/goal <objective>` 实现 `goal.set`，用 `/goal clear` 实现 `goal.clear`，并从原生证据（`/goal` 本地命令输出、Stop hook 判定、错误通知、transcript `goal_status` 记录）推导 Goal 状态。Adapter MUST NOT 伪造 Claude 未报告的达成或失败。

#### Scenario: 确认后才起 Turn
- **WHEN** Claude 以 `Goal set:` 确认 `/goal`
- **THEN** Adapter SHALL 依次发出 `turn.started`、此前缓冲的事件与 `session.goal.changed`
- **WHEN** Claude 拒绝 `/goal`（超长、工作区不受信任或 hooks 受限）
- **THEN** `goal.set` SHALL 失败且 Host MUST NOT 收到该 Turn 的任何事件

#### Scenario: Goal 终态
- **WHEN** Turn 结束
- **THEN** Adapter SHALL 读取 transcript `goal_status` 记录，以 `achieved` 或 `unachievable` 报告终态，或在 Goal 仍存在时保持不变

#### Scenario: 历史显示
- **WHEN** 历史读取遇到 `/goal <objective>` 命令记录
- **THEN** SHALL 显示为 `/goal <objective>`
- **WHEN** 遇到 `/goal` 状态查询或 `/goal clear`（含别名）记录
- **THEN** SHALL 作为控制记录隐藏
