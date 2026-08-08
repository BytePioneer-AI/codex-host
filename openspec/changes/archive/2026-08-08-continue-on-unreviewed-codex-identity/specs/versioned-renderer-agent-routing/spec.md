## ADDED Requirements

### Requirement: 未评审标题服务标识 SHALL NOT 单独阻断安全安装
主进程标题策略 SHALL 把服务必要结构与已评审压缩身份分开判断。只有在标题服务路径、prototype `generateTitle`、已评审函数结构和Renderer ownership安装均成立时，未知压缩类名 MAY被分类为有界warning并继续安装；任何必要结构失败 MUST保持现有fail-closed行为。

#### Scenario: 只有压缩类名变化
- **WHEN** `threadMetadataGeneration`服务来自已评审AppHost路径，prototype `generateTitle`及其函数结构匹配，Renderer ownership可以唯一建立，但`constructor.name`不在已评审集合
- **THEN** 标题策略 SHALL 完成ownership包装、Renderer reload和readiness
- **AND** locked Codex仍 SHALL调用原始官方标题服务
- **AND** Pi、Claude Code、未知外部Agent和歧义ownership仍 SHALL返回本地fallback
- **AND** 安装状态 SHALL携带`unreviewed-title-service-identity` warning

#### Scenario: 必要标题结构失败
- **WHEN** 服务路径、service prototype、`generateTitle`函数、已评审函数结构或Renderer ownership任一缺失、歧义或不匹配
- **THEN** 标题策略 SHALL拒绝安装并保持fail closed
- **AND** 用户选择或确认缓存 MUST NOT覆盖该失败

#### Scenario: 已评审标识完整匹配
- **WHEN** 必要标题结构通过且服务压缩类名位于已评审集合
- **THEN** 标题策略 SHALL按现有行为安装且不产生未评审身份warning
