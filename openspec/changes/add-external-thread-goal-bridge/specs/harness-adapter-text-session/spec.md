## ADDED Requirements

### Requirement: Harness 可暴露其拥有的 Session Goal
拥有原生 Goal 的 Harness Session SHALL 通过可选的 `goal` 能力暴露 `set({turnId, objective})`、`clear()` 与 `read()`，并通过 `session.goal.changed` 事件报告 Harness 中立的 `HostGoal` 或其结束原因（`achieved` / `unachievable` / `cleared` / `error`）。没有原生 Goal 的 Harness MUST NOT 暴露该能力。

#### Scenario: 设置 Goal 起 Turn
- **WHEN** Host 调用 `goal.set`
- **THEN** Harness SHALL 以自己的原生方式开始该 Goal 的第一个 Turn，并复用普通 Turn 生命周期事件
- **AND** objective MUST NOT 成为可见的用户输入

#### Scenario: 读取与清除不投影 Turn
- **WHEN** Host 调用 `goal.read` 或 `goal.clear`
- **THEN** Harness MUST NOT 发出 Turn 生命周期事件
