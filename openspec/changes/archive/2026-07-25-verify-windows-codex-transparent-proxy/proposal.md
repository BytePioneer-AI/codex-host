## Why

codexhost 的产品方案依赖 Codex Desktop 通过 `CODEX_CLI_PATH` 启动可替换程序，并要求 Shim 位于 Desktop 与官方 app-server 之间时不破坏 Codex 原生行为。当前仓库只有 Launcher/Shim 空骨架，Windows AppX 启动、参数形状、环境继承、stdio 生命周期和透明转发仍是未经本机实证的关键假设；在这些事实成立前实现 Protocol Core、Pi 路由或正式 UI 会把高风险猜测固化为产品代码。

## What Changes

- 建立 Windows Codex Launch Probe：发现当前安装、拒绝复用已运行的 Desktop 实例，并用仅作用于本次启动的 `CODEX_CLI_PATH` 环境启动官方 Desktop。
- 捕获并脱敏记录 Desktop 对替代程序的实际 argv、cwd、必要环境字段、stdio、退出状态和进程关系，不记录凭据、Prompt、完整消息或无关环境变量。
- 根据捕获事实实现实验性 Launcher/Shim：识别 app-server 与非 app-server 调用，定位官方 Codex CLI，并清除或重写 `CODEX_CLI_PATH` 防止递归。
- 对 stdin/stdout 执行不解析、不改写的双向字节转发；将诊断限制在 stderr 或受限日志，并传播 EOF、取消、崩溃和退出码。
- 采集脱敏 app-server Fixture，建立字节透明性、生命周期和官方直连/Shim 链路的差分测试。
- 在当前 Windows Codex Desktop 与 Codex CLI 版本上执行 Gate A 验证，形成可审查的通过、失败或架构调整结论。
- 本变更不实现 Pi RPC、Harness 路由、Protocol Core 协议转换、Renderer 注入、Mapping Store、正式 Shared Contracts、安装器或发布流程。

## Capabilities

### New Capabilities

- `windows-codex-transparent-proxy-probe`: 定义 Windows Codex Desktop 调用探测、官方 Codex CLI 透明转发、生命周期保持、脱敏证据和差分验收要求。

### Modified Capabilities

无。

## Impact

- 主要影响 `crates/launcher`、`crates/shim`、`crates/platform`、`tools/`、`tests/fixtures/` 和 `tests/differential/`。
- 与真实 Windows Codex Desktop、其内置或已定位的官方 Codex CLI 及 Windows 进程/应用激活能力交互。
- 不改变 npm Workspace 依赖方向，不引入 Renderer 或 Harness SDK 依赖，不承诺 macOS Gate A 已通过。
- 验证生成的原始日志和未脱敏捕获属于本地临时产物，必须保持忽略；仓库只提交脱敏 Fixture 和结论记录。
