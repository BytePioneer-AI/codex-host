## Why

Gate A 和 Gate C 已经产生足够的已评审证据，可以把只有元数据导出的 `shared-contracts` 骨架升级为第一批正式 Runtime Contracts。在 Gate B 前统一这些契约，可以避免 Probe 临时结构、Codex 私有协议猜测或 Pi 原生标识被固化成互不一致的跨 package API。

## What Changes

- 为 JSON 值、Harness/Host 标识符、兼容 Codex app-server 的 JSON-RPC Envelope、opaque Native Session/Turn/Checkpoint 引用和最小跨边界错误结构增加浏览器安全的 TypeScript 类型与 Zod Runtime Schema。
- 保留已观察到的 Codex app-server Envelope 方言，包括不要求 `jsonrpc` 字段、双向请求 ID、成功与错误 Response 互斥，以及透明转发所需的未知字段。
- Native Ref 使用独立于 Harness 或协议版本的格式版本，opaque locator 仅允许 JSON 可序列化数据，不承载 Transcript 内容或凭据。
- 增加 Runtime 负例、TypeScript 品牌隔离、已评审 Gate A Fixture、序列化和公共导出测试。
- 扩展自动源码边界检查，禁止 `shared-contracts` 导入 Node.js built-in、Electron 私有 API 或 Harness SDK。
- 不在本变更中定义未经验证的 `CreateThreadIntent`、Bridge、Host Operation/Event/Interaction、Mapping Store Record、Pi RPC 或 Codex Method 专属 Schema。

## Capabilities

### New Capabilities

- `shared-runtime-contracts`: 定义 Renderer 与本地 Runtime package 共同使用的最小、浏览器安全、可运行时校验的数据契约。

### Modified Capabilities

- `engineering-workspace`: 扩展自动模块边界门禁，保护 `shared-contracts` 的浏览器安全属性。

## Impact

- 主要实现位于 `packages/shared-contracts/src/` 和 `packages/shared-contracts/test/`。
- 边界门禁影响 `tools/check-boundaries.mjs` 及其测试。
- 证据输入来自已评审 Gate A app-server Fixture 和已提交 Gate C 结论；不读取或复制本地原始 Gate C 证据。
- 后续 `renderer-extension`、`desktop-control`、`harness-adapter`、`mapping-store` 和 `protocol-core` 可以消费这些契约。
- 不增加新的 Runtime 依赖、外部进程、用户持久化数据或产品 UI。
