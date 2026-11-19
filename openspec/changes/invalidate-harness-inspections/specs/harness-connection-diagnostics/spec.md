## MODIFIED Requirements

### Requirement: Renderer 必须复用现有检查链路且保持内存态

`renderer-binding-probe.ts` 的 `refreshHarnessAvailability` MUST 在每次真实检查完成后收集错误字段到内存快照（`harnessAvailabilityErrors`），并提供 `connectionDiagnostics`（`snapshot` / `refresh` / `subscribe`）供设置页使用。诊断状态 MUST 是内存态，不引入持久化日志。检查时机（启动检测、失败重试、窗口 focus、手动刷新、Adapter 重连）MUST 保持原有语义。Web/Console 共享设置页 MUST 继续使用 `purpose: "availability"`；已有检查进行中收到手动刷新时 MUST 等待其结束，再合并执行一次 `refresh: true` 的检查，后台调用 MUST 复用在途检查。

#### Scenario: 检查命中成功缓存

- **WHEN** `inspectHarness({ refresh: false })` 命中 Adapter 成功缓存
- **THEN** Renderer 的可用性状态与诊断快照 MUST 保持为已有结果
- **AND** MUST NOT 假装发生了一次新的检查（例如伪造新的检查时间）

#### Scenario: 新增 Harness 接入诊断

- **WHEN** 一个新 Harness Adapter 满足 Adapter 侧约定后注册进 Renderer
- **THEN** Renderer 的连接诊断 MUST 自动为其渲染状态与错误详情
- **AND** Renderer 代码 MUST NOT 需要为该 Harness 添加条件分支

#### Scenario: 后台检查期间点击手动刷新

- **WHEN** Web/Console 设置页后台检查尚未完成，用户点击刷新
- **THEN** 当前检查结束后 MUST 发出 `purpose: "availability"` 且 `refresh: true` 的请求
- **AND** 手动刷新 Promise MUST 等待后续刷新完成

#### Scenario: 检查期间连续点击刷新

- **WHEN** 同一次在途检查期间用户连续点击三次刷新
- **THEN** MUST 只追加一次刷新检查，而非吞掉刷新或无限排队
