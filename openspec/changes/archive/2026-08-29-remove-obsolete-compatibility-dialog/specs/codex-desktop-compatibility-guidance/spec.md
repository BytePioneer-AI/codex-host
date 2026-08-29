## MODIFIED Requirements

### Requirement: Recoverable Renderer installation failures SHALL NOT be compatibility guidance
Launcher compatibility guidance SHALL NOT present Title Policy structure failure、Agent routing structure failure、Draft routing structure failure或未分类inspection failure为用户可见兼容问题。这些失败 MUST NOT触发兼容弹窗、兼容专用更新入口、自动切换原版Codex或本地兼容确认写入。

#### Scenario: Controller正在恢复Renderer能力
- **WHEN** 当前Controller无法完成Title、Agent、Draft或inspection安装但保持运行重试
- **THEN** Launcher SHALL继续受管codexhost启动且不显示兼容弹窗
- **AND** SHALL NOT因该状态调用兼容专用更新检查、写入兼容确认或自动切换原版Codex

### Requirement: 兼容诊断 SHALL 有界且脱敏
技术诊断 SHALL只包含 Desktop/codexhost版本、能力、稳定reason code以及必要结构状态。Launcher MUST NOT为Renderer兼容状态生成用户提示或持久化确认。诊断 MUST NOT包含Prompt、Transcript、Model值、Thread/Request ID、函数源码、凭据或用户路径。

#### Scenario: warning 被记录和展示
- **WHEN** Controller记录Renderer集成恢复失败
- **THEN** 技术日志 SHALL使用有界稳定状态定位失败阶段
- **AND** Launcher SHALL不显示兼容弹窗或保存兼容确认
- **AND** 所有未声明的运行时业务数据 SHALL被省略

## REMOVED Requirements

### Requirement: 未评审内部标识 SHALL 显示可继续的兼容提示
**Reason**: 压缩内部标识不是可靠的语义兼容信号，生产Controller已不再生成该warning，并采用运行时结构探测与后台恢复。

**Migration**: Codex Desktop更新由运行时fail-closed探测和维护者更新影响审计处理，不向用户显示兼容提示。

### Requirement: 兼容提示 SHALL 提供三个固定操作
**Reason**: 兼容提示不再存在，其专用继续、更新和切换原版操作没有生产触发路径。

**Migration**: 正常codexhost更新继续通过Settings更新界面提供；官方Codex fallback和独立启动行为保持现有非弹窗路径。

### Requirement: 相同 warning 确认 SHALL 按本地指纹记忆
**Reason**: 生产Controller不再生成warning，因此本地确认文件没有可达消费者。

**Migration**: 新版本停止读取和写入旧确认文件；现有本地文件无需迁移或主动删除。
