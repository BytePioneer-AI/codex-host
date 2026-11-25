## Purpose

让 CodexHost Web 用户可以从内置会话菜单手动标记未读，并与现有自动完成提醒共用一致的显示和清除行为。

## ADDED Requirements

### Requirement: 内置手动标记未读入口

Web 会话行菜单 SHALL 为未归档、非当前主视图且尚未显示完成未读提醒的会话提供“标记为未读 / Mark as unread”。该操作 MUST NOT 打开会话、改变运行状态或修改 Harness 与 Codex Desktop 的原生已读状态。

#### Scenario: 普通已读会话显示入口

- **WHEN** 用户打开一个未归档、非当前主视图且没有未读提醒的会话菜单
- **THEN** 菜单 SHALL 显示“标记为未读 / Mark as unread”

#### Scenario: 手动标记成功

- **WHEN** 用户选择“标记为未读”
- **THEN** 菜单 SHALL 关闭
- **AND** 该会话 SHALL 显示与自动完成提醒相同的未读状态
- **AND** 当前打开的会话和会话运行状态 MUST NOT 改变

#### Scenario: 不提供无效或互相冲突的入口

- **WHEN** 会话已归档、处于当前主视图或已经有未读提醒
- **THEN** 菜单 MUST NOT 显示“标记为未读”

### Requirement: 手动与自动未读共用显示和清除规则

手动未读 SHALL 复用现有 `completionUnread` 状态。打开会话、重新运行会话及现有 `markCompletionsRead` 操作 SHALL 清除该标记；收起父会话的未读计数和最近会话提示 SHALL 使用同一状态。

#### Scenario: 打开后清除

- **WHEN** 用户打开一个手动标为未读的会话
- **THEN** 该会话的未读提醒 SHALL 被清除

#### Scenario: 父会话汇总

- **WHEN** 一个手动标为未读的子会话位于收起的父会话下
- **THEN** 父会话 SHALL 按现有规则计入该未读状态

#### Scenario: 折叠父会话清除

- **WHEN** 用户通过现有折叠操作清除后代的完成未读提醒
- **THEN** 其中的手动未读标记 SHALL 一并清除

### Requirement: 当前 Web 运行时边界

手动未读 MUST 与现有自动完成提醒一样只保存在当前 Web 前端运行时，刷新后不要求恢复。实现 MUST NOT 新增 Host RPC、持久化字段或 Codex Desktop `thread/readState/update` 调用。

#### Scenario: 刷新页面

- **WHEN** 用户刷新 Web 页面
- **THEN** 手动未读标记可以随现有自动完成提醒一起重置
- **AND** 不得声称它已同步到 Codex Desktop 或其他浏览器
