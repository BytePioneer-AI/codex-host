## Why

Windows Gate A 已证明当前 Launcher/Shim 的透明代理方向成立，但 macOS 的 App bundle 发现、启动方式、进程级 `CODEX_CLI_PATH` 继承、信号和进程组生命周期仍没有真实证据。现在需要在真实 macOS Codex Desktop 上完成独立 Gate A，并把已验证的跨平台代理代码与 macOS 平台能力整理为后续生产 Launcher/Shim 可直接复用的原生基础，而不是再建立一套一次性 Probe 实现。

## What Changes

- 复用现有 Windows Gate 已验证的 Shim 字节泵、argv 转发、官方 CLI 目标校验、递归防护、stdout 纯净性、EOF 和退出状态传播；必要时重构为平台无关核心，但不得改变已验证的 Windows 行为。
- 在 `platform` 和 `launcher` 中增加 macOS 专属的 Codex `.app`/`Info.plist`/配套 CLI 发现、现有实例检测、进程级环境启动、父子进程观察、process group、信号传播和有界进程树清理。
- 分别验证 LaunchServices 与直接执行 App bundle 主可执行文件时的新实例、单实例和环境继承事实，并只采用能够稳定证明本次启动继承 `CODEX_CLI_PATH` 的受支持路径。
- 将安装发现、启动、进程监督、透明转发和清理实现定义为生产候选原生能力；平台探测、原始捕获、脱敏、差分编排和 Gate 报告继续隔离在 `tools/` 与测试目录。
- 扩展现有 Gate A 测试基础，使共享 Shim 和代理语义在 Windows/macOS hermetic 测试中复用，并为 macOS 增加信号、process group、EOF、Crash、强制终止和无孤儿进程测试。
- 对 macOS 官方 CLI 执行直连/Shim 差分，并在真实 Desktop 上验证新建、继续、流式、工具、取消、正常退出、Crash 和强制终止。
- 生成仅含脱敏证据的 macOS Fixture、验证记录和 `PASS`、`FAIL` 或 `BLOCKED` 结论。
- 本变更不实现 Protocol Core、Pi RPC、HarnessAdapter、Renderer 注入、Mapping Store、安装器、签名、公证或发布打包。

## Capabilities

### New Capabilities

- `macos-codex-transparent-proxy-probe`: 定义 macOS Codex Desktop 安装发现、隔离启动、进程级环境继承、透明官方 CLI 转发、信号与进程组生命周期、脱敏证据及真实 Desktop Gate A 验收要求。

### Modified Capabilities

无。

## Impact

- 主要影响 `crates/platform`、`crates/launcher`、`crates/shim`、`tools/gate-a/`、`tests/fixtures/`、`tests/differential/` 和相关 Rust integration tests。
- 继续保留 Rust/Node.js 边界：Rust 只负责原生启动、进程、stdio 和平台能力，不解析 app-server JSONL，也不引入 Host Thread/Harness 领域类型。
- 共享代理核心和平台抽象属于后续生产实现基础；真实安装探测、证据捕获与 Gate 报告不进入正式运行路径。
- 与真实 macOS Codex Desktop、其 App bundle 内配套 Codex CLI、LaunchServices、POSIX process group 和信号能力交互。
- 不新增正式运行时语言或 Harness/Renderer 依赖；不得以 macOS 改动造成 Windows Gate A 行为回归。
