# Spec Delta

## Purpose

允许 Harness 插件声明自己出现在哪些界面，使只适合 Web 的 Harness 不进入 Desktop 的选择器、Thread 列表与事件，同时不改变它的执行归属。

## ADDED Requirements

### Requirement: 插件可声明出现的界面

插件 manifest MAY 声明 `surfaces`，取值为 `desktop` 与 `web` 的非空、无重复子集。未声明时 SHALL 视为同时出现在 Desktop 与 Web，既有插件行为不变。取值非法或为空时，Host SHALL 拒绝加载该插件并给出可辨识的诊断，MUST NOT 回退为全部界面。

#### Scenario: 未声明界面
- **WHEN** 已安装插件的 manifest 未包含 `surfaces`
- **THEN** 该 Harness SHALL 同时出现在 Desktop 与 Web

#### Scenario: 声明仅 Web
- **WHEN** 插件 manifest 声明 `surfaces` 为仅 `web`
- **THEN** Host SHALL 加载该插件并将其标记为仅 Web

#### Scenario: 声明非法
- **WHEN** 插件 manifest 的 `surfaces` 为空或包含未知取值
- **THEN** Host SHALL 不加载该插件并报告诊断

### Requirement: Desktop 不呈现仅 Web 的 Harness

Host 面向 Desktop 时 SHALL 从 Harness 插件列表、新建 Thread 的 Harness 选择、外部 Thread 列表与 Thread 事件中排除仅 Web 的 Harness 及其 Thread。Desktop 以仅 Web 的 Harness 新建 Thread 时，Host SHALL 明确拒绝，MUST NOT 改用其他 Harness 或官方 Codex 执行。

#### Scenario: Desktop 列出 Harness
- **WHEN** Desktop 请求 Harness 插件列表
- **THEN** 结果 SHALL 不包含仅 Web 的 Harness

#### Scenario: Desktop 列出 Thread
- **WHEN** Desktop 请求 Thread 列表，而 Host 中存在仅 Web Harness 的外部 Thread
- **THEN** 结果 SHALL 不包含这些 Thread

#### Scenario: 仅 Web 的 Thread 产生事件
- **WHEN** 仅 Web Harness 的 Thread 开始或完成 Turn
- **THEN** Host SHALL 不向 Desktop 发送该 Thread 的事件

#### Scenario: Desktop 尝试以仅 Web 的 Harness 新建
- **WHEN** Desktop 请求以仅 Web 的 Harness 新建 Thread
- **THEN** Host SHALL 返回明确错误且不创建 Thread

### Requirement: 界面声明不改变执行归属与 Web 行为

仅 Web 的 Harness SHALL 与其他外部 Harness 一样由共享 Host 的外部 Thread 运行时执行、持久化与恢复。Web SHALL 照常列出、新建、执行和导入它的 Thread。关闭 Desktop 或 Web 网关 MUST NOT 因界面声明而停止这些 Thread 的执行。

#### Scenario: Web 使用仅 Web 的 Harness
- **WHEN** Web 以仅 Web 的 Harness 新建 Thread 并发送消息
- **THEN** 该 Thread SHALL 出现在 Web 列表中并按外部 Thread 的通用规则执行

#### Scenario: Web 网关关闭
- **WHEN** 仅 Web 的 Harness Thread 正在执行时 Web 网关退出
- **THEN** 该 Thread SHALL 继续由共享 Host 执行
