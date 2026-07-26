## MODIFIED Requirements

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
