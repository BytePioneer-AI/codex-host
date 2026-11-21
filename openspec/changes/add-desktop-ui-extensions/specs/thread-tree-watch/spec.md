# Spec Delta

## Purpose

让 Codex Desktop 的界面持续获得委派 Thread 树的关系和各 Thread 的实时状态，状态以实际执行该 Thread 的 Host 为准，供侧栏扩展等只读呈现使用。

## ADDED Requirements

### Requirement: 订阅 Thread 树快照

Host SHALL 允许 Desktop 连接订阅 Thread 树。订阅后先返回一份完整快照，包括：子 Thread 到显示父 Thread 的关系（与 Web Thread 树的规则一致：只计委派关系、置顶的 Thread 为顶层、外部客户端发起的任务不计为子 Thread），以及关系中出现的每个 Thread 的 Harness、已知的标题、状态和归档标记。官方 Codex Thread 的 Harness SHALL 为 `codex`。

#### Scenario: 首次订阅

- **WHEN** Thread A 委派了 B 和 C，Desktop 发起订阅
- **THEN** 快照中 B、C 的显示父 Thread 为 A，并包含 A、B、C 各自的 Harness 和状态

#### Scenario: 置顶的子 Thread

- **WHEN** B 是 A 的委派子 Thread 且已被置顶
- **THEN** 快照中 B 不以 A 为父 Thread，B 的后代仍然跟随 B

### Requirement: 状态以执行所有者为准

每个 Thread 的状态 SHALL 为运行中、等待处理（有未处理的审批、提问或计划审阅，包括多选提问）、空闲、未知之一，并 SHALL 反映实际执行该 Thread 的 Host。当 Desktop 连接的 Host 与执行外部 Thread 的共享 Host 不是同一个时，系统 SHALL 采用所有者的运行和交互状态。尚未观察到 Turn 时，初始状态 SHALL 取自执行所有者明确报告的运行或空闲；所有者未加载该 Thread、报告错误、读取失败、暂时无法联系或无法确认所有者时 SHALL 报告未知，MUST NOT 推断为空闲。

#### Scenario: 在共享 Host 中运行

- **WHEN** 一个外部 Thread 由 Web 发起 Turn，在共享 Host 中运行
- **THEN** Desktop 的订阅把该 Thread 报告为运行中；Turn 结束后变为空闲

#### Scenario: 等待多选提问

- **WHEN** 一个委派子 Thread 正在等待用户回答多选提问
- **THEN** 该 Thread 的状态为等待处理

#### Scenario: 订阅前已在运行的官方 Thread

- **WHEN** 一个官方 Codex 子 Thread 在 Desktop 订阅之前已开始 Turn，订阅后尚未收到任何 Turn 事件
- **THEN** 官方运行时报告其正在运行时显示运行中；官方运行时未加载该 Thread 或读取失败时显示未知，而不是空闲

#### Scenario: 所有者暂时断开

- **WHEN** Desktop 连接的 Host 暂时无法联系共享 Host
- **THEN** 由共享 Host 执行的 Thread 显示为未知；连接恢复后推送实际状态

### Requirement: 变化推送

关系、置顶、Turn 开始与结束、交互出现与处理完成，以及标题变化后，Host SHALL 在一秒内向订阅者推送新的完整快照。快照 SHALL 带有单调递增的版本号，订阅者以最新版本替换旧状态。短时间内的多次变化 SHALL 合并推送。

#### Scenario: 新的委派

- **WHEN** 订阅期间 A 又委派了 D
- **THEN** 订阅者在一秒内收到包含 D 的新快照，版本号大于之前的快照

#### Scenario: 高频变化

- **WHEN** 多个子 Thread 在同一时刻先后开始运行
- **THEN** 订阅者收到合并后的少量快照，最终状态与实际一致

### Requirement: 订阅生命周期与边界

订阅者取消订阅或连接断开时，Host SHALL 释放该订阅。快照大小 SHALL 有上限，超出时 SHALL 明确报告被截断，MUST NOT 静默丢弃部分关系。订阅是只读的，MUST NOT 改变 Thread 执行、归属、置顶或归档。Web 现有的 Thread 树读取与变化通知 SHALL 保持不变。

#### Scenario: Desktop 断开

- **WHEN** 已订阅的 Desktop 连接断开
- **THEN** Host 不再为该连接计算或推送快照，其他连接的订阅不受影响

#### Scenario: Web 行为不变

- **WHEN** Desktop 订阅了 Thread 树
- **THEN** Web 侧栏仍通过原有的树读取和变化通知获得相同的父子关系
