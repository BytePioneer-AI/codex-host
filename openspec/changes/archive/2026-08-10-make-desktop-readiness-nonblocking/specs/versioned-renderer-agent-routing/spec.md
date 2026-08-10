## ADDED Requirements

### Requirement: Renderer prerequisites SHALL gate only external capability availability
Renderer Model target uniqueness, Adapter readiness, Draft Prewarm clearing, and Title Policy ownership SHALL remain mandatory before external Agent controls can successfully switch or submit. Failure of those prerequisites MUST keep the affected external capability unavailable, but SHALL NOT terminate the managed Desktop or become Launcher compatibility guidance.

#### Scenario: Agent Model target is unavailable during recovery
- **WHEN** the Adapter cannot identify one supported Composer Model target
- **THEN** Pi and Claude Code switching or submission SHALL remain unavailable
- **AND** the Controller SHALL continue background installation recovery without terminating official Codex use

#### Scenario: Draft Prewarm clearing fails during external selection
- **WHEN** an external Agent switch cannot clear the owned Draft prewarm state
- **THEN** the switch SHALL fail and the Adapter SHALL remain unavailable for external submission
- **AND** the managed Desktop SHALL remain running for official Codex and later recovery

## MODIFIED Requirements

### Requirement: 未评审标题服务标识 SHALL NOT 单独阻断安全安装
主进程标题策略 SHALL 把服务必要结构与已评审压缩身份分开判断。只有在标题服务路径、prototype `generateTitle`、已评审函数结构和Renderer ownership安装均成立时，未知压缩类名 MAY被分类为有界warning并继续安装。必要结构失败 SHALL使外部Agent能力保持不可用并进入Controller后台恢复，但 MUST NOT终止受管Desktop或产生Launcher兼容错误。

#### Scenario: 只有压缩类名变化
- **WHEN** `threadMetadataGeneration`服务来自已评审AppHost路径，prototype `generateTitle`及其函数结构匹配，Renderer ownership可以唯一建立，但`constructor.name`不在已评审集合
- **THEN** 标题策略 SHALL 完成ownership包装、Renderer reload和readiness
- **AND** locked Codex仍 SHALL调用原始官方标题服务
- **AND** Pi、Claude Code、未知外部Agent和歧义ownership仍 SHALL返回本地fallback
- **AND** 安装状态 SHALL携带`unreviewed-title-service-identity` warning

#### Scenario: 必要标题结构失败
- **WHEN** 服务路径、service prototype、`generateTitle`函数、已评审函数结构或Renderer ownership任一缺失、歧义或不匹配
- **THEN** 标题策略 SHALL拒绝本次外部能力安装并保持Pi与Claude Code不可用
- **AND** Controller SHALL保留受管Desktop并后台重试，不得向Launcher发送阻断兼容结果

#### Scenario: 已评审标识完整匹配
- **WHEN** 必要标题结构通过且服务压缩类名位于已评审集合
- **THEN** 标题策略 SHALL按现有行为安装且不产生未评审身份warning
