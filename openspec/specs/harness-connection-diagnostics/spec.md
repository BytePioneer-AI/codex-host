# harness-connection-diagnostics Specification

## Purpose

记录 codexhost 连接诊断（Connections 设置页）的端到端实现约定：Adapter 如何采集失败阶段、耗时与脱敏 stderr，Renderer 如何在不新增专用 RPC 的前提下展示、刷新与复制诊断。本文档面向后续新增 Harness，目标是让新 Harness 只需满足 Adapter 侧约定即可自动获得完整诊断展示能力。

## Requirements

### Requirement: 错误契约必须结构化且向后兼容

`HarnessError`（`packages/harness-adapter/src/text-session.ts`）与共享的 `CodexhostError`（`packages/shared-contracts/src/errors.ts`）MUST 只增加可选字段：`stage`、`durationMs`、`stderrTail`。原有必填字段（`code`、`message`、`retryable`）及其语义 MUST NOT 改变，旧错误实例 MUST 继续可解析。Adapter 或 Renderer MUST NOT 把阶段、耗时、stderr 拼接进单个 `message` 字符串。

#### Scenario: 旧 Harness 返回无诊断字段的错误

- **WHEN** 一个 Harness 检查失败并返回仅含 `code`、`message`、`retryable` 的错误
- **THEN** Renderer 诊断页面 MUST 仍能渲染摘要与详情
- **AND** 新增的可选字段 MUST 保持缺失而不是被填充零值或占位文本

#### Scenario: 诊断字段跨进程传输

- **WHEN** Host 把 Adapter 的 `HarnessInspection` 结果透传给 Renderer
- **THEN** `stage`、`durationMs`、`stderrTail` MUST 通过现有 `harness/inspect` 响应链路传递
- **AND** MUST NOT 为此新增诊断专用 RPC 或持久化日志文件

### Requirement: Adapter 必须在检查时采集诊断事实

每个 Harness Adapter 的 `inspect`（连接检查）MUST 按阶段推进并记录当前阶段（例如 `spawn`、`startup`、`model-catalog`、`capabilities`、`resolve-executable`），MUST 记录检查总耗时 `durationMs`。子进程 stderr MUST 使用 `pipe` 并持续消费，避免因管道背压阻塞子进程。stderr 文本 MUST 通过 `sanitizeDiagnosticTail`（`packages/harness-adapter/src/diagnostics.ts`）只保留尾部约 8,000 字符并脱敏常见凭证（API Key、Token、Password、Bearer 等）。检查失败时 MUST 把 `stage`、`durationMs`、`stderrTail` 放入结构化错误返回。

#### Scenario: 新增一个 Harness 的连接检查

- **WHEN** 新 Harness 的 `inspect` 在启动阶段启动子进程并失败
- **THEN** 该 Adapter MUST 返回包含失败阶段、耗时的结构化错误
- **AND** 若子进程 stderr 有输出，MUST 返回脱敏且限长后的 `stderrTail`
- **AND** stderr 采集 MUST NOT 改变成功检查返回的 `status`、`catalog`、`capabilities`

#### Scenario: stderr 包含敏感值

- **WHEN** 子进程 stderr 中出现 `API_KEY=...`、`Authorization: Bearer ...` 等常见凭证形式
- **THEN** 复制到剪贴板或展示在页面上的文本 MUST 以 `[redacted]` 替换凭证值
- **AND** 完整原始 stderr MUST NOT 出现在受版本控制文件或诊断副本中

### Requirement: Renderer 必须复用现有检查链路且保持内存态

`renderer-binding-probe.ts` 的 `refreshHarnessAvailability` MUST 在每次真实检查完成后收集错误字段到内存快照（`harnessAvailabilityErrors`），并提供 `connectionDiagnostics`（`snapshot` / `refresh` / `subscribe`）供设置页使用。诊断状态 MUST 是内存态，不引入持久化日志。检查时机（启动检测、失败重试、窗口 focus、手动刷新、Adapter 重连）MUST 保持原有语义。

#### Scenario: 检查命中成功缓存

- **WHEN** `inspectHarness({ refresh: false })` 命中 Adapter 成功缓存
- **THEN** Renderer 的可用性状态与诊断快照 MUST 保持为已有结果
- **AND** MUST NOT 假装发生了一次新的检查（例如伪造新的检查时间）

#### Scenario: 新增 Harness 接入诊断

- **WHEN** 一个新 Harness Adapter 满足 Adapter 侧约定后注册进 Renderer
- **THEN** Renderer 的连接诊断 MUST 自动为其渲染状态与错误详情
- **AND** Renderer 代码 MUST NOT 需要为该 Harness 添加条件分支

### Requirement: 设置页必须结构化展示并可复制

Connections 设置页（`packages/renderer-extension/src/settings/pages.ts`）MUST 为每个 Agent 展示状态徽标与错误摘要，失败项默认展开详情（错误码、错误消息、是否可重试、失败阶段、检查耗时、`diagnostic`、stderr 尾部）。MUST 提供单个 Agent 与全部 Agent 的诊断复制，复制文本 MUST 包含脱敏后的 stderr。复制操作 MUST 给出"已复制 / 复制失败"的短暂按钮反馈。

#### Scenario: 用户复制全部诊断

- **WHEN** 用户在 Connections 页点击"复制全部诊断信息"
- **THEN** 剪贴板 MUST 获得按 Agent 分组的诊断文本
- **AND** 按钮 MUST 短暂显示"已复制"（失败时显示"复制失败"）后恢复原文案

#### Scenario: 新增 Harness 的诊断展示

- **WHEN** 新 Harness 返回含 `stage`、`durationMs`、`stderrTail` 的错误
- **THEN** 设置页 MUST 直接渲染这些字段
- **AND** 页面展示与复制逻辑 MUST NOT 因新 Harness 而修改

### Requirement: 诊断不得改变 Agent 选择规则

Agent picker 的选择条件 MUST 保持为 Renderer Adapter `state === "ready"` 且 Agent `availability === "ready"`。诊断采集、展示与复制 MUST NOT 影响选择、切换、模型加载或会话流程。`ready` Agent MUST NOT 因诊断功能引入持续后台轮询。

#### Scenario: Agent 已 ready

- **WHEN** 一个 Agent 的可用性为 `ready`
- **THEN** picker 与之前一样可选
- **AND** 后台 MUST NOT 因诊断功能周期性重启该 Agent 的检查进程

#### Scenario: 新 Harness 的检查失败

- **WHEN** 新 Harness 的可用性不是 `ready`
- **THEN** picker 选择规则 MUST 与现有 Harness 完全一致地拒绝选择
- **AND** 诊断页面 MUST 展示其失败详情
