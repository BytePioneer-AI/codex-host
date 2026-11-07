# Spec Delta

## Purpose

规定 Codex CLI 作为普通外部 Harness 接入时的身份、原生启动、配置语义与能力边界，使它在 Web 中与其他 CLI Harness 一致，且不触及 GUI 中的官方 Codex。

## ADDED Requirements

### Requirement: Codex CLI 使用独立身份且仅出现在 Web

Codex CLI SHALL 以 `codex-cli` 身份作为预装外部 Harness 提供，并声明仅出现在 Web。官方 `codex` 身份 SHALL 继续保留给 GUI 原生路由，外部 Harness MUST NOT 使用它。官方 Codex Thread 的执行、历史与列表 MUST NOT 经由 Codex CLI Harness。

#### Scenario: GUI 新建官方 Codex Thread
- **WHEN** 用户在 Desktop 中新建 Codex Thread
- **THEN** 该 Thread SHALL 走官方原生路由
- **AND** Desktop 的 Harness 选择中 SHALL 不出现 Codex CLI

#### Scenario: Web 列出会话
- **WHEN** Web 列出会话
- **THEN** 结果 SHALL 包含 Codex CLI 的外部 Thread
- **AND** SHALL 不包含官方 Codex Thread

### Requirement: Codex CLI 通过本地原生 CLI 启动

Codex CLI SHALL 按与其他 Harness 相同的可执行文件发现与启动设置解析本地 `codex`，并以原生 app-server 执行。解析结果为 codexhost 代理或 shim 时 SHALL 报告不可用且不执行。Codex home SHALL 取自 `CODEX_HOME`，未设置时为用户目录下的 `.codex`。认证 SHALL 完全由原生 CLI 负责，Host MUST NOT 读取、复制或预检凭据。

#### Scenario: 未安装 Codex
- **WHEN** 系统中找不到原生 `codex`
- **THEN** 检查结果 SHALL 为未安装

#### Scenario: 解析到 shim
- **WHEN** 解析到的可执行文件是 codexhost 代理或 shim
- **THEN** 检查结果 SHALL 为不可用
- **AND** Host SHALL 不以它启动会话

#### Scenario: 原生认证失败
- **WHEN** 原生 CLI 因未登录或凭据失效而失败
- **THEN** Turn SHALL 以原生错误失败，Host 不做额外认证处理

### Requirement: Codex CLI 尊重原生配置

用户未选择权限模式时，Codex CLI MUST NOT 向原生会话下发审批或沙箱参数，SHALL 使用用户原生配置的默认值。用户选择权限模式时，SHALL 只下发该模式对应的原生审批策略与沙箱模式，MUST NOT 写死网络访问、可写目录等原生配置项。

#### Scenario: 未选择权限模式
- **WHEN** 用户未选择权限模式即发送消息
- **THEN** 原生会话 SHALL 按用户原生配置的审批与沙箱设置执行

#### Scenario: 原生配置允许网络
- **WHEN** 用户原生配置在工作区写入沙箱中允许网络，并选择了对应的权限模式
- **THEN** 该会话 SHALL 保留原生配置的网络访问

### Requirement: Codex CLI 只暴露原生真实能力

Codex CLI SHALL 只声明原生 app-server 实际支持的能力，包括 Turn、取消、审批与提问交互、模型与推理强度、原生命令、历史快照与会话导入。原生不支持的能力 SHALL 声明为不支持，包括 Fork 与回滚最后一个 Turn。Host 无法处理的原生请求 SHALL 立即以错误回应，MUST NOT 使 Turn 挂起。

#### Scenario: 请求 Fork
- **WHEN** 用户对 Codex CLI Thread 请求 Fork
- **THEN** 该操作 SHALL 按能力不支持处理，不创建新 Thread

#### Scenario: Turn 进行中追加消息
- **WHEN** 用户在 Codex CLI Turn 进行中追加消息
- **THEN** Host SHALL 按外部 Thread 对所有 Harness 统一的 steering 规则处理

#### Scenario: 原生发起未支持的请求
- **WHEN** 原生会话向 Host 发起其无法处理的请求
- **THEN** Host SHALL 立即回应错误，Turn 继续由原生决定结果

### Requirement: 原生会话通过通用导入接入且旧隔离数据不迁移

Codex CLI SHALL 通过与其他 Harness 相同的导入流程列出 Codex home 中的原生会话，导入后 SHALL 成为可继续的外部 Thread。此前隔离 Web Codex 来源保存的会话与组织数据 SHALL 不被读取、迁移或删除，也不出现在 Web 会话列表中。

#### Scenario: 导入原生会话
- **WHEN** 用户在 Web 中从 Codex CLI 导入一个原生会话
- **THEN** 该会话 SHALL 成为 Codex CLI 外部 Thread 并保留原生历史

#### Scenario: 存在旧隔离数据
- **WHEN** Host 数据目录中存在旧的 Web Codex 隔离来源数据
- **THEN** Host SHALL 不读取也不删除这些数据
- **AND** Web 会话列表 SHALL 不包含其中的会话
