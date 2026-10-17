## Purpose

规定 GUI、Web 与 Console 对 Host 管理状态的刷新时机及资源边界，使支持事件的状态通过通知与确认快照保持一致，并让缺少完整事件覆盖的状态采用可见性约束的必要查询，保持跨端同步、断线恢复和原生 Codex 路径。

## ADDED Requirements

### Requirement: 排序变更通过确认快照同步

支持排序事件的入口 SHALL 在订阅后读取初始快照，并在 Host 保存排序成功后按通知读取最新快照，无需用户刷新。无变化且连接正常时 SHALL NOT 持续轮询排序；失败写入 SHALL NOT 被广播为成功变更。缺少事件支持的兼容入口 SHALL 保持可用刷新路径。

#### Scenario: 一端修改排序

- **WHEN** GUI、Web 或 Console 成功修改排序
- **THEN** 其他支持事件且已连接的入口 SHALL 自动显示 Host 确认的排序
- **AND** 保存期间失败的输入 SHALL NOT 替换已确认排序

#### Scenario: 空闲与重连

- **WHEN** 支持排序事件的连接持续空闲且没有状态变化
- **THEN** 入口 SHALL NOT 定时查询排序
- **WHEN** 入口重连或恢复可见
- **THEN** 它 SHALL 读取最新快照，补齐未接收的变化

### Requirement: Web 会话目录与项目检查具有独立刷新边界

Web 事件模式 SHALL 通过首次读取、会话变更通知、重连和用户刷新维护完整会话目录；项目定时检查 SHALL 复用已确认的会话身份，SHALL NOT 重扫会话分页或重复查询所有权。项目查询失败 SHALL 保留已确认视图。

#### Scenario: 事件连接空闲

- **WHEN** Web 已连接事件通道且会话无变化，项目检查周期到达
- **THEN** Web SHALL 仅查询项目归属，SHALL NOT 发起定时的全量会话与所有权查询

#### Scenario: 会话和项目分别变化

- **WHEN** 会话被创建、归档、恢复或更名
- **THEN** Web SHALL 根据通知重新核对会话目录
- **WHEN** GUI 调整项目归属而没有对应事件
- **THEN** Web SHALL 在保留的项目检查后更新显示归组，执行 cwd SHALL 保持原值

### Requirement: 共享连接仅在断线期间计划重试

共享 Host 连接正常时 SHALL NOT 定时发起连接尝试。连接失败或断开后 SHALL 采用最高 15 秒的退避重试，每次最多一个在途连接请求；成功或销毁后 SHALL 取消计划重试。用户请求触发的连接 SHALL 复用在途工作。

#### Scenario: 在线后断线再恢复

- **WHEN** 连接已成功建立
- **THEN** 空闲期间 SHALL 不产生定时连接尝试
- **WHEN** 连接随后断开
- **THEN** 宿主 SHALL 重试并在恢复后重新核对目录，旧连接的迟到结果 SHALL NOT 覆盖新连接

### Requirement: 必要健康查询随页面可见性调度

远程连接页和 Console 概览 SHALL 在页面打开、恢复可见、用户刷新或操作结束时查询最新状态。稳定状态的计划查询间隔 SHALL 为 30 秒；远程操作或 Console 启动进行中 SHALL 为 5 秒。隐藏、离页或销毁后 SHALL 停止计划查询，迟到结果 SHALL NOT 修改退役视图。

#### Scenario: 稳定页面隐藏后恢复

- **WHEN** 稳定的远程连接页或 Console 概览不可见
- **THEN** 隐藏期间 SHALL 不产生周期状态查询
- **WHEN** 页面重新可见
- **THEN** 页面 SHALL 合并恢复信号读取一次快照，再按稳定周期查询

#### Scenario: 操作或启动进行中

- **WHEN** 可见的远程连接页有待完成操作，或 Console 显示启动中
- **THEN** 页面 SHALL 按 5 秒周期获取真实状态，结束后恢复 30 秒周期
- **AND** 一台远程 Host 失败 SHALL NOT 阻止其他 Host 的结果显示

### Requirement: 刷新信号合并且结果受生命周期保护

同一状态源的刷新信号 SHALL 合并在途读取，SHALL NOT 产生无界并发请求。读取期间收到新变化 SHALL 在当前读取结束后再次核对。旧请求和旧连接的响应 SHALL NOT 覆盖当前确认状态；销毁后 SHALL 清理订阅及计划任务。

#### Scenario: 读取中收到连续通知

- **WHEN** 一次快照读取未完成，连续通知及用户刷新到达
- **THEN** 客户端 SHALL 保持最多一个在途读取，并在结束后读取包含最后变化的快照

#### Scenario: 读取中离开页面

- **WHEN** 页面或连接被替换或销毁，随后旧读取返回
- **THEN** 旧读取 SHALL NOT 回写新视图，已清理的订阅 SHALL NOT 创建新请求

### Requirement: 优化保持兼容与执行所有权

本优化 SHALL 保持旧 CDP 的必要目录及历史查询、通道心跳、空闲释放检查、更新进度查询和委派任务观察。状态刷新 SHALL NOT 接管 GUI 原生 Codex 执行、启动另一份外部 Harness Session，或引入草稿共享与队列持久化。

#### Scenario: 旧入口与原生 Codex 同时使用

- **WHEN** 旧 CDP 入口缺少事件通道，且 GUI 使用官方 Codex 会话
- **THEN** 旧入口 SHALL 继续通过已有回退获取状态，官方会话执行 SHALL 保持原有路径
- **AND** 优化引起的状态读取 SHALL NOT 创建新的 Harness Session
