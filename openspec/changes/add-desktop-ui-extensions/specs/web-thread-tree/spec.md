# Spec Delta

## MODIFIED Requirements

### Requirement: 树关系只用于整理视图

显示父 Thread 只决定侧栏中的位置。它 MUST NOT 改变 Thread 的 Harness 归属、执行、路由、输入能力、标题或委派状态，也 MUST NOT 改变置顶或归档行为。codexhost 主干 MUST NOT 改变 Codex Desktop 侧栏；只有用户主动启用的 Desktop 界面扩展可以改变其呈现，禁用后侧栏恢复原样。

#### Scenario: 子 Thread 仍可直接使用

- **WHEN** 用户打开一个显示在其他 Thread 下的委派子 Thread
- **THEN** 该 Thread SHALL 保留输入框，可以直接续聊、改名、Fork 和被引用

#### Scenario: Desktop 保持原样

- **WHEN** Web 把 B 显示在 A 下，且 Desktop 没有启用会改变侧栏的界面扩展
- **THEN** Codex Desktop 的侧栏 SHALL 仍按原有方式显示 B

#### Scenario: 用户启用了侧栏扩展

- **WHEN** 用户启用了把子 Thread 显示在父 Thread 下的 Desktop 界面扩展，之后又禁用它
- **THEN** 启用期间 B 的置顶、归档和执行行为不变；禁用后 Desktop 侧栏恢复原有显示
