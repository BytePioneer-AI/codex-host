# Proposal

## Why

Web Codex 现在由 Host 内一套与外部 Thread 路径平行的独立运行栈承载：独立 owner、会话运行时、存储、组织数据、专用通道与 RPC，并且改写了原生沙箱语义。这偏离了"按原生接口接入、保留原生语义"的原则。Codex 不应是特例：在 GUI 中它就是原生 Codex，在 Web 中它就是又一个 CLI Harness。

## What Changes

- Codex CLI 以独立身份 `codex-cli` 作为普通外部 Harness 预装，由共享 Host 的外部 Thread 运行时执行，复用 Mapping Store、组织、交互、事件与导入。官方 `codex` 身份及 GUI 原生路由不变。
- 新增插件 manifest 可选字段 `surfaces`，声明 Harness 出现在哪些界面；`codex-cli` 声明仅 Web。Host 不向 Desktop 呈现仅 Web 的 Harness 及其 Thread，也不允许官方 Codex Thread 委派给它。
- Adapter 只暴露原生 app-server 真实提供的能力：未选权限模式时不下发审批与沙箱参数，不再写死网络与可写目录；可执行文件按通用发现与启动设置解析，保留拒绝 codexhost shim。
- **BREAKING** 删除隔离 Web Codex 来源：Host owner、`/v1/web-codex/*` 通道与事件、`web-codex` 插件 scope 与偏好 scope、Web 双来源组合、Web `--codex-command` / `--codex-home` 参数、隔离会话运行时及其组织存储。
- **BREAKING** 删除只为 Codex 新增、只被隔离运行时消费的可选契约 `steer` 与 `readHistory`。Codex CLI 使用外部运行时对所有 Harness 统一的 steering。
- 不迁移 `<data>/web-codex/`：不读取、不删除。原生会话仍在 Codex home 中，可通过通用导入重新接入。
- 取代未归档的 `unify-gui-web-session-ownership` 与 `add-web-codex-authentication`，删除这两个 change 目录；它们的能力从未进入 `openspec/specs/`。

## Decisions

- **新身份，不放开 `codex` 保留。** 保留规则保证外部路由永不接管官方 Codex；Mapping Store 的原生键包含 Harness 身份，新身份不与任何记录冲突。放弃：继续维护独立 owner，它重复了 Host 已有的执行、存储与同步能力。
- **可见性用通用 manifest 字段，不按 Harness 身份特判。** 现有启用设置是 Host 级、GUI 与 Web 共享，无法表达"仅 Web"。放弃：不过滤，这会让 GUI 同时出现原生 Codex 与 Codex CLI 两个入口。
- **不保留原生 steer。** 外部运行时对所有 Harness 使用同一套 steering；若要原生同 Turn 追加，应作为外部运行时的通用能力另行提案，而不是 Codex 专属契约。

## Capabilities

### New Capabilities

- `harness-plugin-surfaces`：插件声明出现的界面；Host 对 Desktop 隐藏仅 Web 的 Harness 与其 Thread。
- `codex-cli-harness`：Codex CLI 作为普通外部 Harness 的身份、原生启动、配置语义与能力边界。

### Modified Capabilities

- `cross-harness-delegation`：官方 Codex Thread 不能列出或委派给仅 Web 的 Harness。

## Impact

- `packages/adapters/codex` → `codex-cli`：身份、manifest、启动、参数与契约收敛；加入 `scripts/release/harness-plugins.json`。
- `shared-contracts`：manifest `surfaces` 字段；删除 Web Codex owner 合约、事件与 scope。
- `host-runtime`：Desktop 呈现与委派过滤；删除 Web Codex owner 与通道端点。
- `desktop-control`、`web-server`：删除 Web Codex 通道调用与双来源组合，Web 只经外部 Thread 路径。
- `session-runtime`：删除隔离会话、组织与数据存储；保留共用的投影、日志与用量计量。
- `harness-adapter`：删除可选 `steer`、`readHistory`。
- 文档与测试同步；Rust、Mapping Store 格式、GUI 官方路由不变；不新增依赖。
