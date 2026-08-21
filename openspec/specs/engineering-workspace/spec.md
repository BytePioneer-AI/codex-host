# engineering-workspace Specification

## Purpose

定义 codexhost 工程 Workspace、固定工具链、统一质量命令、模块边界和跨平台 CI 的可复现基线。
## Requirements
### Requirement: 工具链兼容且依赖可复现

仓库 MUST 使用 Node.js 22.19+ 或 24、可用的 npm、Rust 工具链和已提交的依赖锁文件。开发和真实 Gate MUST 只校验 Node.js major version 为 22 或 24，MUST NOT 因 Node.js patch version 或 npm version 与仓库记录不同而阻止运行。CI 和发布流程 MAY 记录或固定已验证的精确工具链版本用于复现，但该记录不得成为本地事实探索的版本门禁。

#### Scenario: 全新检出安装依赖

- **WHEN** 开发者使用 Node.js 22.19+ 或 24 和可用 npm 在全新检出中安装依赖
- **THEN** npm 和 Cargo MUST 使用已提交的锁文件解析确定的依赖版本
- **AND** 安装过程 MUST NOT 依赖用户全局安装的 TypeScript、构建器或测试框架

#### Scenario: 本地工具版本与记录版本不同

- **WHEN** 当前 Node.js major version 为 22 或 24，但 Node.js patch version 或 npm version与 CI/发布记录不同
- **THEN** 本地开发和真实 Gate MUST允许继续运行
- **AND** 诊断 MAY记录实际版本但 MUST NOT把差异判定为失败或阻塞

#### Scenario: Node.js major version不兼容

- **WHEN** 当前 Node.js major version 不是 22 或 24
- **THEN** 需要 Node.js 的开发命令 MUST明确报告兼容性错误

### Requirement: 架构一致的 Workspace 结构

仓库 SHALL 使用 npm Workspaces、TypeScript Project References 和 Cargo Workspace，并创建架构基线规定的三个 Rust crates 与八个 TypeScript packages。所有模块 MUST 能在尚未实现业务功能时独立参与构建和检查。

#### Scenario: 构建全部 Workspace

- **WHEN** 开发者在依赖安装完成后运行根构建命令
- **THEN** `crates/launcher`、`crates/shim` 和 `crates/platform` MUST 成功构建
- **AND** `packages/shared-contracts`、`packages/harness-adapter`、`packages/mapping-store`、`packages/protocol-core`、`packages/desktop-control`、`packages/host-runtime`、`packages/renderer-extension` 和 `packages/adapters/pi` MUST 成功构建

#### Scenario: 初始化范围保持最小

- **WHEN** 工程 Workspace 初始化完成
- **THEN** 各模块 MUST 只包含验证导出、构建和测试链路所需的最小实现
- **AND** 初始化变更 MUST NOT 实现 Codex 透明代理、Pi RPC、Mapping Store 业务逻辑或 Renderer 产品功能

### Requirement: 统一质量命令

仓库 MUST 从根目录提供构建、格式检查、Lint、类型检查、测试和综合检查命令。`npm run check` MUST 执行确定且无需真实 Codex Desktop 或 Pi 安装的 TypeScript 与 Rust 质量检查。

#### Scenario: 执行综合检查

- **WHEN** 开发者在根目录运行 `npm run check`
- **THEN** 格式检查、ESLint、TypeScript Strict 类型检查、单元/契约测试、Rust fmt、Clippy 和 Rust 测试 MUST 被执行
- **AND** 任一子检查失败 MUST 使综合检查返回非零退出码

#### Scenario: 外部程序 E2E 独立执行

- **WHEN** 开发者运行普通 `npm run check`
- **THEN** 流程 MUST NOT 要求本机安装 Codex Desktop 或 Pi
- **AND** Renderer/E2E 测试 MUST 可通过独立的 `npm run test:e2e` 命令执行

### Requirement: 自动保护模块边界

工程 MUST 通过可在 CI 运行的静态规则保护 Renderer、Shared Contracts 和 Workspace 依赖边界，而不只依赖代码评审约定。`shared-contracts` MUST 保持浏览器安全，并 MUST NOT 依赖 Node.js built-in、Electron 私有 API、Harness SDK或其他内部 package。

#### Scenario: Renderer 引入本地运行时能力

- **WHEN** Renderer Extension 源码导入 Node.js built-in、Electron 私有 API 或 Harness SDK
- **THEN** 类型检查、Lint 或专用边界检查 MUST 失败

#### Scenario: Shared Contracts 引入本地运行时能力

- **WHEN** Shared Contracts 源码导入 Node.js built-in、Electron 私有 API、Harness SDK或其他内部 package
- **THEN** 类型检查、Lint 或专用边界检查 MUST 失败

#### Scenario: Package 跨目录导入源码

- **WHEN** 一个 Workspace package 绕过另一个 package 的公开导出并跨目录导入其源码
- **THEN** 静态检查 MUST 失败
- **AND** 合法的内部依赖 MUST 使用 Workspace package 名导入

### Requirement: Windows 与 macOS 持续集成

仓库 MUST 建立原生 Windows 和原生 macOS CI 作业，并用仓库固定的工具链执行同一套安装、综合检查和构建流程。

#### Scenario: 提交通过跨平台验证

- **WHEN** CI 针对一个提交运行
- **THEN** Windows 和 macOS 作业 MUST 分别从锁文件安装依赖
- **AND** 两个平台 MUST 执行 `npm run check` 与 `npm run build`
- **AND** 只有两个平台作业均成功时，工程初始化验证才可视为通过

#### Scenario: 平台作业失败

- **WHEN** 任一平台发生安装、检查、测试或构建失败
- **THEN** CI MUST 返回失败并保留足以定位失败阶段的日志
- **AND** 另一平台成功 MUST NOT 掩盖该失败

