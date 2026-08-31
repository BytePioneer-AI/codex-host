# Renderer 与产品接入

实现 `HarnessAdapter` 只完成了执行层接入。一个能够在 Codex Desktop 中被用户选择、创建 Thread、恢复配置并显示状态的正式 Harness，还必须接入 Renderer 和 Desktop Control 的静态 Agent 注册面。

如果本次工作只是后端 Adapter 原型，可以明确推迟本页要求；否则本页全部适用。

## 当前请求链路

新 Thread 的外部 Harness 路由经过：

```text
Renderer Agent 选择
  → Renderer 写入 codexhost Transport Model carrier
  → Desktop 发出 thread/start
  → protocol-core 解码 carrier
  → Host Runtime 选择 HarnessAdapter
```

因此必须同时检查：

- `packages/protocol-core/src/model-routing.ts`
- `packages/renderer-extension/src/versioned-renderer-adapter.ts`

当前两端分别维护 Transport Model 常量和 encode/decode 逻辑。新增 Harness 后，Renderer 生成的 token 必须能被 `protocol-core` 严格解码；Model、Thinking 和 Permission Mode 必须完整往返。为两端增加兼容性测试，不能只测试其中一端。

## Renderer Agent 注册

检查 `packages/renderer-extension/src/agent-selection-state.ts`：

- 将 Harness 加入 `KNOWN_RENDERER_AGENTS`；
- 更新 `RendererAgent` / `ExternalRendererAgent` 推导出的所有完整映射；
- 为该 Harness 保存所需的 Model、Thinking 和 Permission Mode 草稿状态；
- 更新 restore、read、write 和切换逻辑；
- 确认 Composer 替换、Thread 重访和新 Thread 偏好不会丢失或串用其他 Agent 的配置。

当前文件仍有按 Agent 展开的状态字段和分支。应完成所有适用分支，但不要借新增一个 Harness 进行无关的大规模状态重构；只有多个真实调用方已经证明通用映射更清晰时才抽象。

检查 `packages/renderer-extension/src/renderer-binding-probe.ts`：

- `externalHarnessIds` 和 `externalAgents`；
- Availability 初始化、错误状态、刷新和 Settings 诊断；
- `restoredThreadOwnership()` 中 Harness identity 与 Transport 配置恢复；
- Catalog 加载、Model/Thinking/Permission Mode 选择；
- 新 Thread 配置写入和既有 Thread 配置更新；
- Usage、Credits 和 Harness Commands 的显示与刷新策略。

未知 Harness 不得被恢复成 Codex，也不得静默丢弃配置。Thread ownership 无法解析时应 fail closed。

## Transport Model 写入与恢复

检查 `packages/renderer-extension/src/versioned-renderer-adapter.ts`：

- 基础 Transport Model ID 和 prefix；
- Renderer 侧 encode/decode；
- `transportModelIdForAgent()`；
- `modelSelectionForAgent()`；
- `installCurrentRendererAdapter().applyAgent()` 使用的配置写入；
- `packages/renderer-extension/src/index.ts` 中确实需要公开的导出。

编码规则必须满足：

- 基础 ID 与 `protocol-core` 完全一致；
- 组件使用 transport-safe 的共享 schema；
- 缺失 Model 时不能携带依赖 Model 的 Thinking 或 Permission Mode；
- 空组件、组件数量错误和未知 ID 必须拒绝；
- 新 Harness prefix 不与现有 Harness 冲突；
- 从 `ThreadInspection` 恢复后的配置与创建时写入的配置一致。

## Agent Picker、图标和侧边栏

检查：

- `packages/renderer-extension/src/renderer-agent-picker.ts`
- `packages/renderer-extension/src/renderer-agent-icon.ts`
- `packages/renderer-extension/src/renderer-sidebar-agent-icons.ts`
- `packages/renderer-extension/src/renderer-new-thread-preference.ts`
- `packages/renderer-extension/src/settings/pages.ts`

需要提供：

- 用户可见 Label；
- 可打包的本地图标或内联 SVG；
- 官方安装或快速开始 URL；
- Agent Picker 中的安装、可用性和选择状态；
- 外部 Thread 在侧边栏中的 ownership 图标；
- 新 Thread 最近 Agent 和外部配置偏好；
- Connections Settings 中的 Availability 与诊断展示。

`renderer-extension` 是浏览器包。图标和 UI 代码不得引入 Node.js built-ins、Electron private API、Harness SDK 或远程运行时依赖。

## Model、Thinking 与 Permission Mode

Renderer 使用 `inspect()` 返回的能力和 Catalog 决定控制项：

- `selectModel` 为 true 时必须有可选择的 Model 和有效默认值；
- `selectThinkingOption` 为 true 时，Model 支持的 Thinking ID 必须存在于 Catalog；
- `selectPermissionMode` 为 true 时必须提供 Permission Mode Catalog；
- 新 Thread 的配置通过 Transport Model carrier 写入；
- 已存在 Thread 的配置通过 `codexhost/thread/model/select`、`thinking/select` 和 `permission-mode/select` 更新；
- Adapter 原生确认后，Host 返回的状态必须与 Renderer 显示一致。

公共契约允许固定 Model 或不可选择 Model，但当前 Renderer 的提交就绪逻辑可能仍要求一个已选择的 Catalog Model。如果目标 Harness 使用 `selectModel: false` 或空 Catalog，必须验证 Composer 不会被永久阻塞；必要时补齐通用 Renderer 语义，不能伪造一个不存在的 Model 来绕过 UI。

Harness 专用偏好只在确有产品语义时增加。例如 Claude Code 的 Permission Mode 兼容偏好是特例，不应为每个 Harness机械复制。

## Usage、Credits 与 Commands

Thread Usage 和 Harness Commands 已有通用 Renderer 路径，新增 Harness 通常不需要专用 UI 分支，但必须通过实际 Thread 验证：

- Usage 初始值、主动刷新和通知更新；
- Context Window、Cost 和 Cache 字段的显示；
- `commands.list()` 和 `commands.execute()`；
- Thread 切换或 Composer 替换后不会显示前一个 Harness 的数据。

Account Credits 当前不是 `HarnessAdapter` 的正式字段。Host 在 `packages/host-runtime/src/app-server-host.ts` 通过结构检查读取可选的 `credits()` 和 `refreshCredits()`，Renderer 在 `renderer-binding-probe.ts` 中维护哪些 Agent 需要等待 Account Credits。如果新 Harness 提供 Account Credits，应同步接入这两处并增加测试；否则不要增加 Credits 专用分支。

## Desktop Control 和工具链

生产 Renderer 的启用列表还由 Desktop Control 传入。检查：

- `packages/desktop-control/src/production-controller.ts`
- `packages/desktop-control/src/renderer-control-session.ts`
- 对应测试

同时搜索仓库中的 Agent 白名单和探测工具，尤其是：

- `tools/renderer-binding/run.mjs`
- `tools/renderer-binding/renderer-observer.mjs`
- `tools/codex-desktop-contract-audit/run.mjs`
- `tests/release/production-renderer.test.mjs`
- `packages/renderer-extension/test/`

工具列表与生产列表用途可能不同，不应机械复制；但任何声称覆盖全部生产 Agent 的工具都必须包含新 Harness。新增 Harness 后，用其 ID 搜索与现有 Harness ID 并列出现的数组、联合类型、映射和 switch，逐项判断是否适用。

## 聚焦测试

至少覆盖：

1. Agent union、Label、安装 URL 和图标创建。
2. Renderer Transport Model encode/decode 与 `protocol-core` 兼容。
3. 新 Thread 选择该 Harness 后写入正确 carrier。
4. Model、Thinking、Permission Mode 的默认选择和更新。
5. `ThreadInspection` 能恢复 Agent ownership 和配置。
6. 未安装、不可用、认证失败和重试状态。
7. Agent Picker 与 Settings Connections 展示。
8. 侧边栏外部 Thread 图标。
9. 新 Thread 偏好持久化和非法旧值兼容。
10. Usage、Credits（如支持）和 Commands。
11. Desktop Controller 生产启用列表与 Renderer readiness。
12. 生产 Renderer build 和相关 release test。

## 完成标准

正式产品接入只有在以下条件同时满足时才完成：

- 用户能在 Agent Picker 中看到并选择该 Harness；
- 新 Thread 使用正确 Transport Model 路由到目标 Adapter；
- 既有 Thread 能恢复正确 ownership 和配置；
- Availability、安装入口、图标、Settings 和侧边栏一致；
- Model、Thinking、Permission Mode、Usage、Credits 和 Commands 按声明工作；
- Desktop Control、探测工具和生产 Renderer 测试已覆盖新 Agent；
- Renderer bundle 仍满足浏览器边界和 release 审计。
