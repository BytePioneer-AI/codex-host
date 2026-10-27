# Desktop 产品接入：目录驱动，默认不改 Renderer

当交付范围包含「在 Desktop 中可选、可创建/恢复 Thread、可展示配置与状态」时读本页。本页主要是**验收清单**；正常情况下，新插件不需要修改 Renderer 或 Desktop Control。

## 当前机制

Renderer 已经改为由插件目录驱动（2026-10 起，见 `docs/architecture/harness-plugin-runtime.md#公共查询和路由`）：

| 职责 | 数据来源 | 新插件需要做的 |
|---|---|---|
| Agent 列表、名称、图标 | `codexhost/harness/plugins/list`（Manifest 描述） | 提供 Manifest 的 `name`、`icon`、`iconStyle` |
| 可用性、模型、Thinking、权限控件 | 目标 Host 上的 `codexhost/harness/inspect` | 实现正确的 inspect 和 capabilities |
| Composer 配置草稿和新 Thread 偏好 | 按动态插件 ID 存储，按 Host 隔离 | 无 |
| 创建 Thread | `encodeHarnessPluginRoute` 写入共享载体 `codexhost/plugin-v1@…` | 无 |
| 恢复 Thread 的所属和配置 | `restoredThreadOwnership()` 先用 `decodeHarnessPluginRoute` 走通用路径 | 无（下面的按 ID 分支只用于读取旧编码） |
| 设置 → 连接 | Manifest 的 `installation`、`links`、`notice`、`launchCommand` 以及 `installation()`/`install()` | 见[连接页](spec-connections.md) |
| 用量浮窗和额度 | Usage 事件、`credits()`、`accountCreditsSupported` | 见[用量与账号](spec-usage-accounts.md) |
| 账号设置页 | `accounts/sources` + `accounts/inspect` | 实现 `inspectAccount(s)` |
| 会话导入页 | `sessionImport` | 见[身份与历史](spec-history.md#导入) |

`renderer-binding-probe.ts`、`versioned-renderer-adapter.ts`、`protocol-core/src/model-routing.ts` 中按 Harness ID 写的分支和旧的专用 codec，都是对旧 Thread 的**只读兼容**。不要模仿，也不要为新插件增加分支或专用 codec，更不能借接入之机删除旧格式的读取。

## 可选的仓库内接线

只在预装时考虑以下几项，都不是功能必需：

- `packages/renderer-extension/src/agent-group-preference.ts` 的 `DEFAULT_AGENT_ORDER`：只影响默认的显示顺序，未列出的 ID 排在最后。
- `tools/renderer-binding/run.mjs` 的 `RENDERER_PROBE_AGENTS`、`tools/codex-desktop-contract-audit/run.mjs`：诊断工具覆盖的名单，按实际用途维护。
- `tests/e2e/renderer-<id>.spec.ts`：需要针对 UI 的专项回归时再加。

如果验收中发现**必须**修改 Renderer 才能正确工作（例如某个 Agent 的配置展示依赖按 ID 的分支），这是公共缺口。应把它改成通用逻辑，并在报告中说明，而不是给新 ID 再加一个分支。

## 能力与运行状态

- Catalog 和能力来自目标 Host 的 inspect；effective 状态来自原生确认后的 Thread 状态。
- `selectModel`、`selectThinkingOption`、`selectPermissionMode` 决定对应控件是否显示；`atCreate` 的权限在 Thread 创建后被锁定。
- 配置通过公共的 select 请求更新；失败时不能把 requested 值当作已生效。
- 固定 Model 或空 Catalog 是合法的原生情况，但要验证不会导致 Composer 永久无法提交；不能编造模型来绕过。
- 外部 Thread 的「调整方向」复用 `turn.cancel` → 等待终态 → `turn.start`，插件只需提供[取消与后续 Turn](spec-output-interactions.md#取消与后续-turn) 的基础行为。
- 目录中有某个插件，不代表原生已安装、已认证或可以运行。旧 Host 不支持目录方法时，要明确提示兼容限制。
- Renderer 是浏览器包：不能引入 Node.js built-ins、Harness SDK 或 Electron 私有 API。

## 产品验收

1. 在正确的目标 Host 上能看到、选择并创建该 Harness 的 Thread，且载体使用共享格式。
2. 未安装、认证失败、不可用、旧 Host 不兼容、刷新重试这些状态都显示准确；连接页的安装、更新和启动路径正常工作。
3. 新旧 Thread 的 Model、Thinking、权限、所属、Sidebar 和偏好一致；Host 重启后恢复的配置正确。
4. 切换 Host 或 Thread、Composer 重新挂载、异步响应乱序时，不会串配置或图标。
5. 受支持的工具、审批、提问、取消、调整方向、Usage、命令和历史操作，都经过真实 UI 验证。
6. 插件缺失时，原 Thread 不会交给 Codex；重新安装后，历史恢复情况符合原生能力。
7. 截图只用于有可见变化的 UI。

只完成后端时，报告「插件后端可用，Desktop 未验收」；完成了 UI 但没有做真实原生验收时，同样明确保留该验收项。
