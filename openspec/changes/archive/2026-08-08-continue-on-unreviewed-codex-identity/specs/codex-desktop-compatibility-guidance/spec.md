## ADDED Requirements

### Requirement: 未评审内部标识 SHALL 显示可继续的兼容提示
当必要标题结构和完整生产安装链均已通过，但标题服务内部标识尚未评审时，Launcher SHALL 将该状态呈现为信息性兼容 warning，而不是崩溃、空 readiness 或结构失败。提示 MUST 明确核心检查已通过但当前 Codex build 尚未完成完整验证，MUST NOT 声称完全兼容。

#### Scenario: 新压缩类名仍满足必要结构
- **WHEN** 标题服务路径、prototype方法、函数结构、Renderer ownership、Draft Prewarm Policy和Renderer Adapter均 ready，且只有服务压缩类名不在已评审集合
- **THEN** codexhost SHALL 保持受管 Desktop运行并显示可继续的兼容提示
- **AND** 提示 SHALL 标识受影响能力为自动标题隔离

#### Scenario: 没有兼容 warning
- **WHEN** 标题服务必要结构和内部标识均已评审且生产安装链 ready
- **THEN** Launcher SHALL 正常发布运行状态且 MUST NOT 显示兼容提示

### Requirement: 兼容提示 SHALL 提供三个固定操作
兼容提示 SHALL 提供继续使用 codexhost、获取最新版和使用原版 Codex三个固定操作，不得接受动态命令、URL、路径或版本。

#### Scenario: 用户继续使用 codexhost
- **WHEN** 用户选择继续使用 codexhost
- **THEN** Launcher SHALL 保持当前 Controller、Shim、Host和受管 Desktop
- **AND** SHALL 完成 Runtime Descriptor发布和正常后台监督

#### Scenario: 用户获取最新版
- **WHEN** 用户选择获取最新版
- **THEN** Launcher SHALL 仅打开 `https://github.com/BytePioneer-AI/codex-host/releases/latest`
- **AND** SHALL 保持当前已通过必要检查的受管 Desktop运行

#### Scenario: 用户使用原版 Codex
- **WHEN** 用户选择使用原版 Codex
- **THEN** Launcher SHALL 不发布当前受管 Runtime Descriptor，关闭本次 Controller和受管 Desktop并等待Shim/Host清理
- **AND** SHALL 通过已验证的官方安装身份启动不带codexhost Shim/Host环境的原版Codex

### Requirement: 相同 warning 确认 SHALL 按本地指纹记忆
Launcher SHALL 只为相同 Desktop identity/version/build/ASAR integrity、codexhost version、warning capability/reason和observed identity抑制重复提示。确认记录 MUST为严格、原子、本地且脱敏的数据，并 MUST NOT跳过每次启动的必要结构检查。

#### Scenario: 用户再次启动相同组合
- **WHEN** 用户已选择继续或获取最新版，且后续启动的完整确认指纹完全相同
- **THEN** Launcher SHALL 不重复显示该 warning提示
- **AND** Controller SHALL 仍重新执行必要结构和生产readiness检查

#### Scenario: Desktop或codexhost发生变化
- **WHEN** Desktop identity/version/build/ASAR integrity、codexhost version或warning identity任一变化
- **THEN** 旧确认 SHALL NOT 抑制新 warning提示

#### Scenario: 确认记录不可信
- **WHEN** 确认文件缺失、malformed、Schema未知、为符号链接或不是普通文件
- **THEN** Launcher SHALL 将 warning视为未确认
- **AND** MUST NOT据此改变结构检查结果

### Requirement: 兼容诊断 SHALL 有界且脱敏
用户提示和技术诊断 SHALL 只包含 Desktop/codexhost版本、能力、稳定reason code、已评审与实际内部标识以及必要结构状态。它们 MUST NOT包含Prompt、Transcript、Model值、Thread/Request ID、函数源码、凭据或用户路径。

#### Scenario: warning 被记录和展示
- **WHEN** Launcher接收未评审标题服务标识warning
- **THEN** 用户 SHALL 能看到功能位置和可理解原因
- **AND** 技术日志 SHALL 能定位到稳定reason code与observed identity
- **AND** 所有未声明的运行时业务数据 SHALL 被省略
