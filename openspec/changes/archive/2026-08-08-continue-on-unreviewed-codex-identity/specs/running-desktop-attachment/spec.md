## ADDED Requirements

### Requirement: 首次 Controller readiness SHALL 携带严格兼容 warning
Launcher与首次Desktop Controller之间的readiness协议 SHALL 使用有版本、单行、严格且有界的结构化结果。成功结果 MAY携带已完成生产安装后的兼容warning；warning MUST NOT通过异常文本、stderr匹配或空stdout推断。已发布实例的nonce-authenticated Attachment Server协议保持不变。

#### Scenario: Controller无warning地ready
- **WHEN** Controller完成Title Policy、Renderer ownership、Draft Prewarm Policy和Renderer Adapter安装且没有warning
- **THEN** Controller SHALL返回结构化ready与空warnings
- **AND** Launcher SHALL继续现有Runtime Descriptor发布和detach流程

#### Scenario: Controller带未评审身份warning地ready
- **WHEN** Controller完成全部必要生产安装但标题服务身份未评审
- **THEN** Controller SHALL返回结构化ready及一个有界枚举warning
- **AND** Launcher SHALL在处理该warning前保持本次Controller和Desktop受监督

#### Scenario: readiness结果malformed
- **WHEN** Controller stdout包含未知Schema、未知字段、未知warning枚举、超长值、多行或malformed JSON
- **THEN** Launcher SHALL将其视为技术启动错误
- **AND** MUST NOT把它降级为可继续的兼容warning

### Requirement: Launcher SHALL 在用户决定后发布或放弃受管运行状态
Launcher SHALL在兼容warning已确认、被本地相同指纹确认抑制或用户选择获取最新版后，才发布本次Runtime Descriptor并detach。用户选择原版Codex时，Launcher MUST放弃本次受管状态并完成有界清理后启动官方Desktop。

#### Scenario: warning已被相同指纹确认
- **WHEN** Controller返回warning且Launcher找到完全匹配的有效本地确认
- **THEN** Launcher SHALL不重复提示并继续发布受管运行状态

#### Scenario: 用户打开Releases后继续
- **WHEN** 用户从warning提示选择获取最新版
- **THEN** Launcher SHALL打开固定Releases页面、记录本次确认并继续发布当前受管运行状态

#### Scenario: 原版Codex启动前清理
- **WHEN** 用户选择使用原版Codex
- **THEN** Launcher SHALL确保本次Controller、Shim、Host和受管Desktop已停止且Runtime Descriptor未发布
- **AND** 官方Desktop新进程 MUST NOT继承 `CODEX_CLI_PATH` 或任何 `CODEXHOST_*` 受管环境
