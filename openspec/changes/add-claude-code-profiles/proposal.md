# Proposal

## Why

用户经常需要在 Codex Desktop 中使用多个不同用途或后端的 Claude Code 实例，例如：
1. 不同的环境配置与会话存储目录（工作环境与个人环境、独立 `CLAUDE_CONFIG_DIR`）；
2. 不同的网关与模型路由（如经由企业网关、自建代理或兼容服务接入，提供特定的模型集合与上下文配额）；
3. 专用的包装脚本或启动命令（如指定模型预设、参数或凭据注入的 CLI wrapper）。

目前 codexhost 的 `claude-code` 适配器多处硬编码了 `"claude-code"` 标识符，且每个已装插件只向 Host 注册单一固定 Harness。用户如果想要并行使用第二个 Claude 实例，只能通过复杂复制整个 Adapter 目录并手动处理打包与依赖，既容易在升级时损坏，又破坏了统一的生命周期与配置规范。

codexhost 需要一种**通用、不带私有逻辑的 Claude Code 兼容变体 / Profile** 机制：同一个经过充分验证的 `claude-code` 适配器内核，可以通过外部用户配置文件声明额外的独立 Harness 实例（包括自定义 id、显示名称、图标、启动命令、独立配置目录及环境变量），由 Host 动态发现并注册为一等公民 Harness。

## What Changes

- **公共契约与模式**：在 `@codexhost/shared-contracts` 中定义 `claudeCodeProfileSchema` 及 profiles 配置文件格式；在 `@codexhost/harness-adapter` 的 `HarnessPluginModule` 中声明通用的 `createHarnessProfiles?` 契约，在 `HarnessPluginContext` 中补充可选 `harnessId`。
- **配置发现**：在 `@codexhost/harness-plugin-files` 中提供安全读取外部 profiles 配置（`~/.codexhost/claude-code-profiles.json` 或环境变量指定的配置文件）的能力，支持数据 URL 或本地图片资源的图标转换。
- **动态插件加载**：在 `@codexhost/host-runtime` 的 `loadHarnessPlugins` 中，当加载的插件模块提供 `createHarnessProfiles` 时，由 loader 统一验证并注册派生的 profiles 适配器到 `HarnessPluginRegistry`，确保与普通 Harness 拥有相同的目录发现、权限控制、状态恢复与生命周期管理。
- **Claude Code 适配器参数化**：在 `packages/adapters/claude-code` 中，解耦硬编码的 `"claude-code"` ID，允许构造时指定 `harnessId`、启动命令与 `environment`（包含独立 `CLAUDE_CONFIG_DIR`），正确映射 Native Ref、Pending Session、历史快照与模型目录；在 `plugin.ts` 中实现 `createHarnessProfiles`。
- **Renderer 权限偏好扩展**：使 `renderer-extension` 的权限模式记忆能够支持指定 Harness ID，使 Claude 变体同样享有会话权限偏好记忆。

## Decisions

- **外部配置文件与零硬编码**：Profile 声明一律放置在仓库外（`~/.codexhost/claude-code-profiles.json`），代码和 PR 中不得包含任何具体网关名称、Token、私有路径或商业凭据。
- **公共契约扩展与单一责任**：遵循边界规则，Host Runtime 不直接引用任何具体 Adapter 包，而是通过公共模块接口 `createHarnessProfiles` 驱动；具体实例的构建与参数绑定完全封装在 `claude-code` 插件内部。
- **共享插件路由**：所有变体 Harness 统一采用现有的 `encodeHarnessPluginRoute` / `decodeHarnessPluginRoute` 传输模型标识，Desktop 无需新增专有分支即可完整支持模型切换、Thinking 与权限模式。
- **配置与会话强隔离**：变体实例通过 `CLAUDE_CONFIG_DIR` 隔离本地会话（`projects/`、`history.jsonl`），避免污染官方 `~/.claude`；模型选择器准确反映变体实例环境配置（如 `settings.json` 中的 `modelPicker`）。
- **向后零回归**：原有 `claude-code` 默认行为、启动路径与存储位置保持 100% 字节级一致。
