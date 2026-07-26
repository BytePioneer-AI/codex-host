## 1. 固定工具链与根配置

- [x] 1.1 安装 Rust Stable，记录 `rustc --version` 的完整版本，并创建非浮动的 `rust-toolchain.toml`
- [x] 1.2 创建 `.node-version` 和根 `package.json`，固定 Node.js `24.13.1`、npm `11.8.0` 与 npm Workspaces
- [x] 1.3 创建根 Cargo Workspace 配置和共享 package 元数据
- [x] 1.4 更新 `.gitignore`，排除 `node_modules`、`dist`、`build`、`target`、测试产物和本地环境文件

## 2. 建立 TypeScript Workspace

- [x] 2.1 安装并固定 TypeScript、Zod、Vitest、Playwright、esbuild、ESLint 和 Prettier，提交 `package-lock.json`
- [x] 2.2 创建 `tsconfig.base.json` 和根 Project References 配置，启用 TypeScript Strict Mode
- [x] 2.3 创建 `shared-contracts`、`harness-adapter`、`mapping-store` 和 `protocol-core` 的最小可编译 package
- [x] 2.4 创建 `desktop-control`、`host-runtime` 和 `adapters/pi` 的最小可编译 package
- [x] 2.5 创建 `renderer-extension` 的独立 Browser Target package，并用 esbuild 生成浏览器 JavaScript Bundle
- [x] 2.6 为各 package 配置公开导出和 Workspace package 依赖，禁止跨目录引用其他 package 源码

## 3. 建立 Rust Workspace

- [x] 3.1 创建 `platform` library crate 及最小单元测试
- [x] 3.2 创建 `launcher` 和 `shim` binary crate，并通过 Workspace 依赖复用 `platform`
- [x] 3.3 生成并提交 `Cargo.lock`，验证三个 crate 可在无业务实现时构建和测试

## 4. 建立质量门禁

- [x] 4.1 配置 Prettier、ESLint 和跨平台根命令 `format:check`、`lint`、`typecheck`、`test` 与 `build`
- [x] 4.2 配置 Vitest 冒烟测试和独立的 Playwright `test:e2e` 入口，普通测试不得要求 Codex Desktop 或 Pi
- [x] 4.3 配置 Rust fmt、Clippy 和 Cargo test，并纳入根质量命令
- [x] 4.4 实现 Renderer 禁止导入 Node.js built-in、Electron 私有 API和 Harness SDK 的静态检查
- [x] 4.5 实现 Workspace package 禁止跨目录导入源码的静态检查
- [x] 4.6 建立 `npm run check`，确保任一格式、Lint、类型、单元/契约或 Rust 检查失败时返回非零退出码

## 5. 持续集成与验收

- [x] 5.1 创建 Windows 与 macOS CI 作业，从仓库工具链文件和锁文件安装依赖
- [x] 5.2 在两个平台作业中执行 `npm run check` 和 `npm run build`，并保留分阶段失败日志
- [x] 5.3 在当前 Windows 开发机从清理后的依赖与构建目录执行 `npm ci`、`npm run check` 和 `npm run build`
- [x] 5.4 核对初始化产物不包含 Codex 透明代理、Pi RPC、Mapping Store 业务逻辑或 Renderer 产品功能
- [x] 5.5 运行 `openspec validate initialize-engineering-workspace` 并确认全部工程初始化验收项有对应实现或测试
- [x] 5.6 修正根 `npm test` 的 TypeScript 构建前置，并在 CI 中验证干净检出测试入口
- [x] 5.7 修正 Renderer 受禁 package 的子路径匹配，并增加正反例边界测试
- [x] 5.8 让 CI 通过 `packageManager` 启用固定 npm 版本，移除重复版本声明
- [x] 5.9 移除 E2E smoke 对 `CODEX_CLI_PATH` 未设置的环境假设
