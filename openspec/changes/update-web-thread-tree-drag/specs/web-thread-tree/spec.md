## MODIFIED Requirements

### Requirement: 手动放置 Thread
Web SHALL 允许用户把 Thread 连同其后代移到另一个 Thread 下，或移到任意层级的任意位置。桌面使用拖动（见“拖动放置与排序”）；手机和触屏设备在 Thread 行菜单中提供“移到…下”，打开可搜索的选择器，有显示父 Thread 的 Thread 额外提供“移到顶层”，桌面不显示这两个菜单项。放置由 Host 持久化，Host 或 Web 重启后保持；不理解该数据的旧版本 SHALL 忽略它并继续正常列出全部 Thread。

#### Scenario: 移到其他 Thread 下
- **WHEN** 用户在手机上从 Thread B 的菜单选择“移到…下”并选中 Thread C
- **THEN** B 及其后代 SHALL 显示在 C 下，C 的祖先被展开

#### Scenario: 移回顶层
- **WHEN** 用户对委派子 Thread B 选择“移到顶层”，或在桌面把 B 拖到顶层
- **THEN** B SHALL 显示为顶层 Thread，Host 重启后仍为顶层，不再回到委派父 Thread 下

#### Scenario: 在手机上放置
- **WHEN** 用户在手机宽度下通过行菜单执行“移到…下”
- **THEN** 选择器 SHALL 完整可用且无需拖动

#### Scenario: 重启后保持
- **WHEN** 用户把 B 移到 C 下后重启 Host
- **THEN** B SHALL 仍显示在 C 下

## ADDED Requirements

### Requirement: 各层排序
顶层 Thread 沿用侧栏当前的排序方式。按更新时间排序时，顶层 Thread 的排序时间 SHALL 取它与全部后代中最近的更新时间，同一父 Thread 下的子 Thread 按自身更新时间倒序排列。手动排序时，每一层的顺序独立：顶层使用现有的手动顺序，子 Thread 的顺序按其显示父 Thread 分别保存在当前浏览器；新出现的 Thread 排在该层最前，不再属于该层的 Thread 的记录 SHALL 被忽略。

#### Scenario: 子 Thread 刚完成
- **WHEN** 按更新时间排序，一个较早的顶层 Thread 的子 Thread 刚刚完成新的 Turn
- **THEN** 该顶层 Thread SHALL 移到更新时间对应的位置

#### Scenario: 手动调整子 Thread 的顺序
- **WHEN** 手动排序下，用户把子 Thread B 拖到同一父 Thread 下的 C 之前
- **THEN** B SHALL 显示在 C 之前，刷新后保持

### Requirement: 拖动放置与排序
桌面上，任何已提交、未归档的本机 Thread（包括子 Thread）都 SHALL 可以拖动。手动排序下，把它拖到两行之间时显示插入线，松手后它成为这两行的同级并位于其间，可以从任意层级移到任意层级；按更新时间排序时，把它拖到某一行上并松手使它成为该行的同级，仅改变显示父 Thread。在目标行中间区域稳定停留约 500ms 后，Web SHALL 显示“成为该 Thread 的子 Thread”的提示并在松手时把它放到目标下；离开该区域 SHALL 立即取消。不允许的目标（自身、自身的后代、已归档、远程、草稿、Subagent）不显示落点，也不响应。把 Thread 拖到自己所在分组的标题或空白处 SHALL 移到顶层；拖到其他工作区分组、拖入聊天区域的行为不变。悬停在收起的父 Thread 上约 600ms SHALL 自动展开它。

#### Scenario: 从子级移出到平级的指定位置
- **WHEN** 手动排序下，用户把三层里的 B 拖到其父 Thread A 与相邻顶层 Thread D 之间的插入线
- **THEN** B SHALL 成为顶层 Thread，位于 A 与 D 之间

#### Scenario: 排序不会误挂靠
- **WHEN** 用户把 B 拖过某一行后立即松手，没有在该行中间停留
- **THEN** B SHALL 只成为该行的同级，MUST NOT 成为它的子 Thread

#### Scenario: 停留后成为子 Thread
- **WHEN** 用户把 B 拖到 C 的中间并停留约 500ms，看到“成为 C 的子 Thread”提示后松手
- **THEN** B SHALL 显示在 C 下

#### Scenario: 非法目标
- **WHEN** 用户把 A 拖到它自己的子 Thread 上
- **THEN** Web MUST NOT 显示落点，松手后任何位置都不变

#### Scenario: 拖入聊天区域
- **WHEN** 用户把任意 Thread 拖入聊天区域
- **THEN** 它 SHALL 仍作为会话引用插入，不改变任何位置

## REMOVED Requirements

### Requirement: 树内排序
**Reason**: 子 Thread 现在可以手动排序，原“只有顶层可拖动、子 Thread 固定按时间排序”的规则被“各层排序”取代。
**Migration**: 无数据迁移；子 Thread 的手动顺序在首次拖动时才开始记录，之前按更新时间排序。
