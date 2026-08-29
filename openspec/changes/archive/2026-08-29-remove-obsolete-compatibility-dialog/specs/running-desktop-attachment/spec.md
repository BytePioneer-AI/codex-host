## ADDED Requirements

### Requirement: 首次 Controller readiness SHALL 使用严格compatible结果
Launcher与首次Desktop Controller之间的readiness协议 SHALL使用有版本、单行、严格且有界的结构化结果。当前生产成功结果 MUST为`compatible`且issues为空，MUST NOT携带兼容warning、降级能力或用户决策数据。已发布实例的nonce-authenticated Attachment Server协议 SHALL保留受控实例激活能力，但 SHALL NOT提供兼容弹窗专用更新命令。

#### Scenario: Controller ready
- **WHEN** Controller已启动Attachment Server并进入受管监督
- **THEN** Controller SHALL返回Schema version 2、state `compatible`与空issues
- **AND** Launcher SHALL继续Runtime Descriptor发布和detach流程而不显示兼容提示

#### Scenario: readiness结果包含旧warning
- **WHEN** Controller stdout包含`compatible-with-warning`、`degraded`、非空issues、未知Schema、未知字段、多行或malformed JSON
- **THEN** Launcher SHALL将其视为技术启动错误
- **AND** MUST NOT把它降级为可继续的兼容warning

### Requirement: Launcher SHALL 在严格readiness后发布受管运行状态
Launcher SHALL在收到有效的compatible-only readiness并完成既有Host chain检查后发布本次Runtime Descriptor并detach。Launcher MUST NOT等待兼容warning确认、写入兼容确认、调用兼容专用更新检查或因Renderer兼容状态切换原版Codex。

#### Scenario: 有效readiness
- **WHEN** Controller返回严格有效的compatible-only readiness且Host chain ready
- **THEN** Launcher SHALL发布受管Runtime Descriptor并完成正常后台监督
- **AND** SHALL不显示兼容弹窗

#### Scenario: Renderer集成仍在恢复
- **WHEN** Controller内部Renderer Session不可用但已按非阻塞策略返回有效readiness
- **THEN** Launcher SHALL继续受管启动
- **AND** Renderer恢复 SHALL由Controller后台处理而不是Launcher用户决策处理

## REMOVED Requirements

### Requirement: 首次 Controller readiness SHALL 携带严格兼容 warning
**Reason**: 生产Controller不再生成兼容warning，首次readiness已收敛为compatible-only严格握手。

**Migration**: 使用新增的“首次 Controller readiness SHALL 使用严格compatible结果”要求。

### Requirement: Launcher SHALL 在用户决定后发布或放弃受管运行状态
**Reason**: Launcher不再展示兼容弹窗，也不再等待warning确认或兼容专用更新结果。

**Migration**: 使用新增的“Launcher SHALL 在严格readiness后发布受管运行状态”要求。
