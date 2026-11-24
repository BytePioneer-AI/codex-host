# Spec Delta

## MODIFIED Requirements

### Requirement: 多层树显示
Web 侧栏 SHALL 支持任意层级的 Thread 树，同一个 Thread 只出现一次。远端 Peer 上的 Thread SHALL 按同一 Peer 内的委派关系建树，规则与本机相同。子 Thread 在列表中尚未加载的祖先 SHALL 被补齐，使其显示在正确位置。显示父 Thread 不可见（已删除、未提交的草稿、已归档且当前视图不显示归档）、属于其他 Host 或关系成环时，该 Thread SHALL 作为顶层显示，不被隐藏或重复显示。

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

#### Scenario: Peer 上的委派
- **WHEN** 远端 Peer 上的 Thread A 委派了同一 Peer 上的 Thread B
- **THEN** Web 侧栏 SHALL 把 B 显示在 A 下面，归档 A 时同时归档 B

#### Scenario: 跨主机关系
- **WHEN** 某个 Thread 记录的父 Thread 位于另一台主机
- **THEN** 该 Thread SHALL 作为顶层显示
