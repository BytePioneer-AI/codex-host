## Why

codexhost 已完成公开 MVP 开发前的产品与技术设计，但仓库尚无可构建、可测试的工程骨架，无法开始 P0 技术 Gate。现在需要先建立可复现的 npm/Cargo Workspace、固定工具链和跨平台质量检查，为后续 Probe、Shim、Protocol Core 与 Adapter 实现提供稳定基础。

## What Changes

- 固定仓库使用的 Node.js、npm、TypeScript、Rust 和相关开发工具版本。
- 建立 npm Workspaces、TypeScript Project References 和 Cargo Workspace。
- 按既定模块边界创建 Rust crates 与 TypeScript packages 的最小可编译骨架。
- 建立统一的构建、格式检查、Lint、类型检查、单元测试和综合检查命令。
- 建立 Windows 与 macOS CI，验证全新检出的安装、检查、测试和构建流程。
- 增加 Renderer 浏览器边界和 Workspace 源码导入边界检查。
- 本变更不实现 Codex Launch Probe、透明代理、Pi RPC、Mapping Store 业务逻辑或其他 MVP 功能。

## Capabilities

### New Capabilities

- `engineering-workspace`: 定义 codexhost 工程骨架、固定工具链、模块边界、统一质量命令和跨平台 CI 的可复现要求。

### Modified Capabilities

无。

## Impact

- 新增仓库根级 Node.js、TypeScript、Rust、Lint、格式化和 CI 配置。
- 新增 `crates/`、`packages/` 及最小测试目录结构。
- 新增并锁定 npm 与 Cargo 依赖元数据。
- 开发机需要安装被仓库固定版本的 Rust 工具链；最终产品仍不要求用户安装 Node.js 或 Rust。
- 不改变 PRD、HarnessAdapter、Protocol Facade 或持久化协议的产品语义。
