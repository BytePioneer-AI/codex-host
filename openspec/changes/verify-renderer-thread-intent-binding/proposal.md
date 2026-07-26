## Why

Gate A 已证明 Codex Desktop 可以经 Shim 透明使用官方 app-server，Shared Contracts 也已提供基础 Envelope、ID 和错误结构；但当前仍没有证据证明官方 Renderer 草稿中的 Agent 选择能随同一次真实 Thread 创建请求到达 codexhost。Paseo 已证明更简单的通用模式：草稿按身份隔离、发送时快照最终 Provider/Model/cwd，并由一个自包含创建请求完成创建，不依赖全局“下一个 Provider”或跨通道关联。

Gate B 只验证 Paseo 无法覆盖的 Codex Desktop 私有边界：CDP 注入、真实 Renderer 出站边界，以及完整 `CreateThreadIntent` 能否保留在同一个真实创建 Request 中。

## What Changes

- 参考 Paseo 已验证的草稿级 pending state、`draft → creating → sent/abandoned` 生命周期和发送时最终选择快照，独立实现 Gate-only 最小状态；不复制其 AGPL 代码、自有 UI、WebSocket Daemon 或协议体系。
- 为 Gate A 已验证的启动路径增加本次进程级 CDP 参数，并增加只处理 app-server 调用的 Gate-only Node JSONL 观察转发器；不把现有字节透明 Shim 描述为已经具备协议观察能力。
- 使用最小 direct CDP 连接本次启动的 Codex Desktop，确认 Renderer target，通过 `Page.addScriptToEvaluateOnNewDocument` 和 `Runtime.evaluate` 注入 Browser asset；不引入 Playwright 控制路径、第二套 CDP fallback 或通用 CDP 框架。
- 在当前 Desktop 实际使用的最内层统一出站边界包装一次 `thread/start` 或等价创建 Method。首次发送时快照完整 `CreateThreadIntent`，并写入同一个创建 Request 的 Gate-only namespaced 扩展字段。
- Gate-only JSONL 观察器校验并提取完整 Intent，在转发官方 app-server 前移除扩展字段，按原 JSON-RPC `id`观察真实 Response Thread ID 和首个 Turn 顺序；Pi标记Thread的首个`turn/start`必须在进入官方Codex Agent Loop前被阻止。系统不使用独立 Intent 通道、keyed join、时间窗口、FIFO、全局 `selectedHarness`、`nextHarness` 或运行时 carrier fallback。
- 真实 Gate 覆盖 CDP 注入/重载、真实首发、发送前快速切换、两个 Composer 并发、失败重试与重载隔离五类场景；Hermetic 测试按行为覆盖草稿状态、同请求携带、透明转发、Response 关联和隐私边界，不固定测试数量。
- 只有当前平台真实 Gate `PASS` 后，才把已验证的 `CreateRequestId` 和 `CreateThreadIntent` 提升到 `@codexhost/shared-contracts`；CDP、DOM、页面生命周期、carrier 和 Gate 观察协议保持 Gate-local。
- 本变更不实现正式 Agent 选择器、Pi Turn、HarnessAdapter、Mapping Store、Host Thread 分配、外部 Thread 投影、完整 Protocol Core/Host Runtime、安装器或发布流程。

## Capabilities

### New Capabilities

- `renderer-thread-intent-binding-probe`: 定义最小 Gate B 的 direct CDP 注入、真实出站创建边界、单 Request 完整 Harness 意图、五类真实场景和平台限定证据要求。

### Modified Capabilities

- `shared-runtime-contracts`: 在 Gate B 真实证据成立后增加浏览器安全的 `CreateRequestId` 和 `CreateThreadIntent` Runtime Schema，继续排除 Bridge、carrier、CDP、Pi RPC 和完整业务协议。

## Impact

- 扩展 `launcher`/`platform` 的 Gate 启动能力，使本次 Desktop 进程接受 loopback 随机 CDP 参数；生产边界仍不修改官方安装、全局环境或用户已运行实例。
- 新增 `tools/gate-b/` 的最小 direct CDP Controller、Renderer Browser asset、Node JSONL 观察转发器、场景编排和报告；复用 Gate A 的发现、进程监督和官方 CLI 定位，但不建设完整 Host Runtime。
- 新增 `tests/fixtures/gate-b/` 的确定性脱敏摘要和独立 Gate B 命令；普通 `npm run check` 不启动真实 Desktop、访问真实 CDP、官方 CLI、Pi 或网络。
- 在真实证据关闭后更新 `packages/shared-contracts` 公共导出及 Runtime/Browser bundle 测试，并同步开发状态和技术架构。
