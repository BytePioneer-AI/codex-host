## Context

codexhost 当前只有产品与技术设计文档，尚无 Node.js、TypeScript 或 Rust 工程。工程初始化必须遵循既定的混合技术栈和模块边界，同时为后续 P0 Probe 与技术 Gate 提供可复现的构建和测试入口。

本变更受以下基线约束：

- Node.js 固定为 `24.13.1`，npm 固定为 `11.8.0`；
- Native Launcher、Shim 和平台能力使用 Rust；
- Protocol Core、Desktop Control、Mapping Store 和 Harness Adapter 使用 TypeScript + Node.js；
- Renderer Extension 使用 TypeScript，并构建为浏览器 JavaScript；
- 仓库使用 npm Workspaces、TypeScript Project References 和 Cargo Workspace；
- 正式实现必须面向原生 Windows 和原生 macOS。

## Goals / Non-Goals

**Goals:**

- 建立全新检出后可重复安装、检查、测试和构建的仓库骨架。
- 创建正式架构要求的 crates、packages 和跨模块测试目录。
- 用统一根命令执行 TypeScript 与 Rust 质量检查。
- 在 Windows 和 macOS CI 中验证相同的锁定工具链流程。
- 用自动化规则保护 Renderer 和 Workspace 依赖边界。

**Non-Goals:**

- 不实现 Launcher、Shim 或 Platform Integration 的业务行为。
- 不实现 Codex app-server、Protocol Facade、Renderer 注入或 Bridge。
- 不实现 HarnessAdapter 完整领域类型、Mapping Store 或 Pi RPC。
- 不采集真实 Codex/Pi Fixture，也不执行 Gate A 至 Gate D。
- 不设计发布打包、安装器或产品更新机制。

## Decisions

### 1. 使用两个原生 Workspace，不引入额外任务编排器

Node.js 侧使用根 `package.json` 管理 npm Workspaces，Rust 侧使用根 `Cargo.toml` 管理 Cargo Workspace。根 npm scripts 作为开发者统一入口，并按需调用 `tsc`、Vitest、ESLint、Prettier 和 Cargo。

不引入 pnpm、Yarn、Bun、Turborepo 或 Nx，因为当前模块数量和构建关系可由 npm Workspaces、TypeScript Project References 与 Cargo 原生能力表达，新增编排器只会扩大工具链和发布面。

### 2. 固定并提交完整工具链与依赖解析结果

提交 `.node-version`、`package.json#packageManager`、`package-lock.json` 和 `rust-toolchain.toml`。Rust 安装后将实际完整版本写入工具链文件，不使用浮动的 `stable` channel。Cargo 依赖解析结果写入 `Cargo.lock`。

TypeScript 和开发工具依赖由 lockfile 固定，不依赖全局安装。开发机可以安装 Node.js、npm 和 Rust，最终产品运行时边界仍由后续发布设计处理。

### 3. 按架构模块创建最小可编译骨架

Rust Workspace 包含：

- `crates/launcher`
- `crates/shim`
- `crates/platform`

npm Workspace 包含：

- `packages/shared-contracts`
- `packages/harness-adapter`
- `packages/mapping-store`
- `packages/protocol-core`
- `packages/desktop-control`
- `packages/host-runtime`
- `packages/renderer-extension`
- `packages/adapters/pi`

每个模块只包含验证构建链路所需的最小入口和冒烟测试。模块之间只通过 Workspace package 名和公开导出引用，不跨目录导入其他 package 源码。

### 4. TypeScript 使用 Strict Mode 和 Project References

根 `tsconfig.base.json` 提供共享严格规则，每个 package 使用独立 `tsconfig.json` 并通过 Project References 表达依赖方向。Node.js package 与 Renderer package 使用不同环境配置，防止浏览器构建意外获得 Node.js 类型和能力。

Renderer 使用 esbuild Browser Target 生成浏览器 JavaScript。边界检查同时使用 TypeScript 配置和 ESLint 受限导入规则，禁止 Renderer 引用 Node.js built-in、Electron 私有 API或 Harness SDK。

### 5. 根命令是本地与 CI 的共同契约

根级命令至少包括：

- `npm run build`
- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm test`
- `npm run test:e2e`
- `npm run check`

`npm run check` 执行格式、Lint、TypeScript 类型检查、单元/契约测试以及 Rust fmt、Clippy 和测试。E2E 保持独立，不要求没有真实 Desktop/Pi 环境的普通 `check` 执行外部程序测试。

### 6. CI 直接验证全新检出路径

Windows 与 macOS CI 都从锁文件安装依赖，并执行 `npm run check` 和 `npm run build`。CI 使用仓库工具链文件选择 Node.js、npm 和 Rust 版本，不复制另一套版本声明。

本变更只要求建立这两类平台作业；签名、发布包和依赖真实 Codex Desktop/Pi 的 E2E 属于后续变更。

## Risks / Trade-offs

- [Rust 工具链尚未安装，无法预先记录完整版本] → 初始化任务第一步安装 Rust Stable，立即将 `rustc --version` 对应版本固定到 `rust-toolchain.toml`。
- [空 package 容易产生无意义占位代码] → 只保留验证导出、构建目标和测试链路所需的最小代码，不提前设计业务 API。
- [Windows 与 macOS 对脚本和路径的处理不同] → 根命令使用跨平台 Node.js/工具原生命令，不使用 PowerShell 或 shell script 承载正式构建逻辑。
- [根 `check` 过重会降低开发反馈速度] → E2E 和真实外部程序测试保持独立，`check` 只包含确定、可离线重复的质量检查。
- [边界规则只靠文档可能逐渐失效] → 将 Renderer 和跨 package 导入限制实现为自动化静态检查，并在 CI 执行。

## Migration Plan

当前仓库没有实现代码，无数据或 API 迁移。按以下顺序引入：

1. 安装并固定 Rust 工具链；
2. 创建根 npm/Cargo 配置和锁文件；
3. 创建最小 crates/packages；
4. 建立共享 TypeScript、Lint、格式和测试配置；
5. 建立统一根命令和边界检查；
6. 加入 Windows/macOS CI；
7. 从干净检出验证安装、检查和构建。

若初始化无法稳定通过，可整体回退本 change 新增的工程文件；仓库现有设计文档不受影响。

## Open Questions

无。Rust 的完整固定版本由安装时的实际 Stable 版本确定，这是执行步骤而非架构待决策项。
