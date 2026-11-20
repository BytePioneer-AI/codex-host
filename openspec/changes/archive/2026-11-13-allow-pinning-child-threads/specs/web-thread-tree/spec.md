## ADDED Requirements

### Requirement: 置顶的 Thread 成为顶层
任何 Thread，包括委派出来的子 Thread，都 SHALL 可以置顶。被置顶的 Thread MUST NOT 有显示父 Thread：它作为独立的顶层 Thread 显示在置顶区，它的后代跟随它显示和汇总，并且不再出现在原来的父 Thread 下，也不计入原父 Thread 的后代数量、汇总状态、排序时间和归档级联。取消置顶后，它 SHALL 回到委派父 Thread 下。Web 与 Codex Desktop 共享置顶状态，在 Desktop 中置顶的子 Thread 在 Web 中同样作为顶层显示。

#### Scenario: 置顶子 Thread
- **WHEN** 用户置顶 A 的子 Thread B
- **THEN** B SHALL 显示在置顶区，成为独立的顶层 Thread，B 的后代跟随它
- **AND** B SHALL 不再显示在 A 下，A 的子 Thread 数量与汇总状态不再包含 B 及其后代

#### Scenario: 取消置顶
- **WHEN** 用户取消置顶 B
- **THEN** B SHALL 回到它的委派父 Thread A 下

#### Scenario: 在 Desktop 中置顶
- **WHEN** 用户在 Codex Desktop 中置顶 A 的子 Thread B
- **THEN** Web 侧栏 SHALL 把 B 显示在置顶区，不再显示在 A 下

#### Scenario: 归档原父 Thread
- **WHEN** 用户归档 A，而 A 的子 Thread B 已被置顶
- **THEN** 归档 SHALL 不级联到 B，B 仍显示在置顶区

## MODIFIED Requirements

### Requirement: 显示父 Thread 来自委派关系
每个 Thread SHALL 至多有一个显示父 Thread，即委派该 Thread 的父 Thread（包括升级前已有的委派）；没有委派父 Thread 或已被置顶时作为顶层显示。Web MUST NOT 提供手动改变显示父 Thread 的入口。显示父 Thread 与 Harness 原生 Subagent 的父子关联相互独立；Subagent Thread 不进入侧栏的规则不变。

#### Scenario: 委派子 Thread 自动挂载
- **WHEN** Thread A 通过委派创建了子 Thread B
- **THEN** Web 侧栏 SHALL 把 B 显示在 A 下面

#### Scenario: 历史委派同样生效
- **WHEN** 升级前已经存在 A 委派 B 的关系
- **THEN** 升级后的 Web 侧栏 SHALL 把 B 显示在 A 下面，无需用户操作

#### Scenario: 旧的手动放置被忽略
- **WHEN** 磁盘上留有旧版本保存的手动放置数据
- **THEN** 它 SHALL 被忽略，B 仍按委派关系显示，Thread 记录不受影响

#### Scenario: Subagent 不受影响
- **WHEN** 某个 Thread 有 Harness 原生 Subagent
- **THEN** Subagent MUST NOT 作为树中的子 Thread 出现在侧栏，仍从父 Thread 的现有入口查看

## REMOVED Requirements

### Requirement: 置顶仅限顶层 Thread
**Reason**: 子 Thread 现在可以独立置顶并成为顶层，由“置顶的 Thread 成为顶层”取代。
**Migration**: 无数据迁移；Desktop 中已置顶的子 Thread 在 Web 中改为显示在置顶区。
