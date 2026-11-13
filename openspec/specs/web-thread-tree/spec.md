# web-thread-tree Specification

## Purpose
让 Web 侧栏把相关 Thread 组织成可展开、收起的树：委派子 Thread 自动挂在发起它的父 Thread 下，从而在大量委派后仍能浏览会话列表。

## Requirements

### Requirement: 树关系只用于整理视图
显示父 Thread 只决定 Web 侧栏的位置。它 MUST NOT 改变 Thread 的 Harness 归属、执行、路由、输入能力、标题或委派状态，也 MUST NOT 改变 Codex Desktop 的侧栏、置顶或归档行为。

#### Scenario: 子 Thread 仍可直接使用
- **WHEN** 用户打开一个显示在其他 Thread 下的委派子 Thread
- **THEN** 该 Thread SHALL 保留输入框，可以直接续聊、改名、Fork 和被引用

#### Scenario: Desktop 保持原样
- **WHEN** Web 把 B 显示在 A 下
- **THEN** Codex Desktop 的侧栏 SHALL 仍按原有方式显示 B

### Requirement: 多层树显示
Web 侧栏 SHALL 支持任意层级的 Thread 树，同一个 Thread 只出现一次。子 Thread 在列表中尚未加载的祖先 SHALL 被补齐，使其显示在正确位置。显示父 Thread 不可见（已删除、未提交的草稿、已归档且当前视图不显示归档）、属于其他 Host 或关系成环时，该 Thread SHALL 作为顶层显示，不被隐藏或重复显示。

#### Scenario: 多层委派
- **WHEN** A 委派 B，B 又委派 C
- **THEN** 侧栏 SHALL 显示 A ▸ B ▸ C 三层

#### Scenario: 祖先不在已加载的列表页中
- **WHEN** 子 Thread 在第一页列表中，而它的父 Thread 因更新时间较早尚未加载
- **THEN** Web SHALL 补齐父 Thread（及其祖先），子 Thread 显示在父 Thread 下，不作为顶层出现

#### Scenario: 父 Thread 已归档
- **WHEN** 父 Thread 已归档而子 Thread 未归档，且当前视图不显示归档 Thread
- **THEN** 子 Thread SHALL 作为顶层显示

#### Scenario: 深层缩进
- **WHEN** 树的层级超过三层
- **THEN** 第三层之后的 Thread SHALL 使用与第三层相同的缩进，在手机宽度下不出现横向滚动，层级关系仍可分辨

### Requirement: 子 Thread 跟随顶层 Thread 的分组
整棵树 SHALL 显示在其顶层 Thread 所在的工作区分组（或最近分组）中。子 Thread 的工作目录与顶层 Thread 不同时，MUST NOT 在自己的工作区分组中重复出现。

#### Scenario: 子 Thread 使用其他工作目录
- **WHEN** 顶层 Thread A 属于工作区 X，其委派子 Thread B 的工作目录属于工作区 Y
- **THEN** B SHALL 只显示在 X 分组中的 A 下面，Y 分组中不出现 B

### Requirement: 展开与收起
有子 Thread 的行 SHALL 提供展开、收起控制，并显示子 Thread 数量。新出现的父 Thread 默认收起。展开状态只保存在当前浏览器中，刷新后保持，不影响其他浏览器或设备。打开某个 Thread 时，Web SHALL 展开它的全部祖先；之后用户仍可手动收起。键盘导航 SHALL 能展开、收起和进入子 Thread。

#### Scenario: 默认收起
- **WHEN** A 第一次出现委派子 Thread
- **THEN** A 的行 SHALL 处于收起状态，并显示子 Thread 数量

#### Scenario: 打开深层子 Thread
- **WHEN** 用户通过链接或搜索打开一个位于收起树中的第三层 Thread
- **THEN** 它的全部祖先 SHALL 被展开，且该 Thread 在侧栏中可见并被选中

#### Scenario: 刷新后保持
- **WHEN** 用户展开 A 后刷新页面
- **THEN** A SHALL 仍处于展开状态

### Requirement: 收起的父 Thread 汇总后代状态
收起的父 Thread SHALL 在自身状态之外，显示整棵子树（全部后代）的汇总状态：是否有后代正在运行、是否有后代等待用户处理交互（审批、计划审阅、提问）、是否有后代未读完成。展开后，各子 Thread 显示各自的状态，父 Thread 只显示自身状态。有后代正在运行或等待处理交互的顶层 Thread SHALL 不被侧栏的“显示更多”截断隐藏。

#### Scenario: 收起时子 Thread 等待审批
- **WHEN** A 处于收起状态，其孙 Thread C 正在等待审批
- **THEN** A 的行 SHALL 显示“有后代等待处理”的提示

#### Scenario: 后代运行中的旧 Thread
- **WHEN** 一个较早的顶层 Thread 超出侧栏默认显示数量，但它的某个后代正在运行
- **THEN** 该顶层 Thread SHALL 仍显示在侧栏中

### Requirement: 树内排序
顶层 Thread 沿用侧栏当前的排序方式。按更新时间排序时，顶层 Thread 的排序时间 SHALL 取它与全部后代中最近的更新时间；手动排序时，只有顶层 Thread 可以拖动调整顺序。同一父 Thread 下的子 Thread SHALL 固定按自身更新时间倒序排列，不支持拖动排序。

#### Scenario: 子 Thread 刚完成
- **WHEN** 按更新时间排序，一个较早的顶层 Thread 的子 Thread 刚刚完成新的 Turn
- **THEN** 该顶层 Thread SHALL 移到更新时间对应的位置

#### Scenario: 子 Thread 不参与拖动排序
- **WHEN** 用户在手动排序下拖动一个子 Thread
- **THEN** Web MUST NOT 改变任何 Thread 的顺序或显示父 Thread
- **AND** 把该子 Thread 拖入聊天区域作为会话引用的功能 SHALL 不受影响

### Requirement: 归档与恢复级联到后代
在 Web 中归档一个 Thread 时，Web SHALL 同时归档其全部后代；恢复时 SHALL 同时恢复其全部后代。后代包括列表中尚未加载的 Thread。归档确认 SHALL 列出整棵子树中正在运行的 Thread。单独归档某个子 Thread 只影响该 Thread 及其后代。级联中部分 Thread 失败时，Web SHALL 报告失败的 Thread，已成功的不回滚。

#### Scenario: 归档有正在运行后代的父 Thread
- **WHEN** 用户归档 A，而 A 的子 Thread B 正在运行
- **THEN** 确认提示 SHALL 列出 B
- **AND** 确认后 A 与其全部后代 SHALL 被归档

#### Scenario: 恢复父 Thread
- **WHEN** 用户恢复已归档的 A
- **THEN** A 的全部后代 SHALL 同时恢复，并重新显示在 A 下

#### Scenario: 在 Desktop 中归档
- **WHEN** 用户在 Codex Desktop 中归档 A
- **THEN** 只有 A 被归档，A 的子 Thread 在 Web 中作为顶层显示

### Requirement: 搜索结果保持平铺
侧栏搜索结果 SHALL 保持平铺，不按树折叠；有显示父 Thread 的结果 SHALL 同时显示其父 Thread 的标题，便于区分同名 Thread。打开搜索结果时按“展开与收起”的规则展开其祖先。

#### Scenario: 搜索命中子 Thread
- **WHEN** 搜索命中一个位于收起树中的子 Thread
- **THEN** 该结果 SHALL 直接出现在搜索结果中，并显示其父 Thread 的标题

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
