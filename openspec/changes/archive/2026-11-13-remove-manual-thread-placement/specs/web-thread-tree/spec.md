## ADDED Requirements

### Requirement: 显示父 Thread 来自委派关系
每个 Thread SHALL 至多有一个显示父 Thread，即委派该 Thread 的父 Thread（包括升级前已有的委派）；没有委派父 Thread 时作为顶层显示。Web MUST NOT 提供手动改变显示父 Thread 的入口。显示父 Thread 与 Harness 原生 Subagent 的父子关联相互独立；Subagent Thread 不进入侧栏的规则不变。

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

### Requirement: 置顶仅限顶层 Thread
Web SHALL 只为顶层 Thread 提供置顶操作；置顶的顶层 Thread 连同整棵子树显示在置顶区，并可在置顶区展开、收起。已经置顶的 Thread 作为委派子 Thread 显示时，Web SHALL 按未置顶显示并隐藏其置顶操作，但 MUST NOT 修改 Host 与 Codex Desktop 共享的置顶状态。

#### Scenario: 置顶带子树的 Thread
- **WHEN** 用户置顶有子 Thread 的顶层 Thread A
- **THEN** A 及其后代 SHALL 显示在置顶区，且不在普通分组中重复出现

#### Scenario: 子 Thread 菜单
- **WHEN** 用户打开子 Thread 的行菜单
- **THEN** 菜单 MUST NOT 提供置顶操作

#### Scenario: 已置顶 Thread 是委派子 Thread
- **WHEN** 已置顶的 Thread B 是 A 的委派子 Thread
- **THEN** B SHALL 显示在 A 下且不显示为置顶
- **AND** Codex Desktop 中 B 的置顶状态 SHALL 保持不变

## MODIFIED Requirements

### Requirement: 树关系只用于整理视图
显示父 Thread 只决定 Web 侧栏的位置。它 MUST NOT 改变 Thread 的 Harness 归属、执行、路由、输入能力、标题或委派状态，也 MUST NOT 改变 Codex Desktop 的侧栏、置顶或归档行为。

#### Scenario: 子 Thread 仍可直接使用
- **WHEN** 用户打开一个显示在其他 Thread 下的委派子 Thread
- **THEN** 该 Thread SHALL 保留输入框，可以直接续聊、改名、Fork 和被引用

#### Scenario: Desktop 保持原样
- **WHEN** Web 把 B 显示在 A 下
- **THEN** Codex Desktop 的侧栏 SHALL 仍按原有方式显示 B

## REMOVED Requirements

### Requirement: 显示父 Thread 的来源与优先级
**Reason**: 手动放置被移除，显示父 Thread 只来自委派关系，由新增的“显示父 Thread 来自委派关系”取代。
**Migration**: 无数据迁移；旧的手动放置数据被忽略。

### Requirement: 手动放置 Thread
**Reason**: 手动放置与拖动挂靠的实际需求不明确，却带来大量交互与实现复杂度。
**Migration**: 已放置的 Thread 回到委派关系决定的位置；无委派父 Thread 的作为顶层显示。

### Requirement: 手动放置的约束
**Reason**: 随手动放置一并移除。
**Migration**: 无。

### Requirement: 只有顶层 Thread 可以置顶
**Reason**: 由“置顶仅限顶层 Thread”取代，仅去掉与手动放置有关的场景。
**Migration**: 无。
