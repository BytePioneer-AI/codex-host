## Why

Claude Code CLI 的能力面有一大半来自 Skills（`~/.claude/skills`、项目的 `.claude/skills`、plugins、`.claude/commands`），而 CodexHost 目前只静态注册了 `/compact`、`/init`、`/recap` 三条命令。用户在 Codex Desktop 里选中 Claude Code 后，无法发现也无法调用任何 skill。

同时当前 Claude Adapter 传入 SDK 的 `settingSources` 只有 `["user"]`，按 SDK 语义这会跳过项目级 settings，且 **必须包含 `"project"` 才会加载 CLAUDE.md**。也就是说 CodexHost 里的 Claude Code Thread 今天并没有读到项目的 CLAUDE.md，也没有扫描项目 skills。这是一个与 CLI 的行为差距，不只是缺一个按钮。

## What Changes

- Claude Adapter 的 SDK `settingSources` 从 `["user"]` 扩展为 `["user", "project", "local"]`，对齐 Claude Code CLI 默认，使项目 CLAUDE.md、项目 settings 与项目 skills 生效。
- Claude Adapter 通过官方 SDK 的原生枚举接口 `supportedCommands()` 与初始化响应中的 `skills` 名单发现当前 session 可用的 skill，投影成命令 catalog。
- 会话中途的 `system/commands_changed` push 事件刷新该 catalog（REPLACE 语义）。
- `harness-adapter` 的能力接口增加可选 `skills` capability，**复用**既有 `HarnessCommandCapability` 与 `HarnessCommandCatalog` 类型，不新建 skill 专属抽象。
- Host 新增 `codexhost/thread/skills/inspect`（params/result 复用既有 schema，无新契约类型）；skill 执行**复用**既有 `codexhost/thread/command/execute` 与 command ID 路由，边界校验改为 Commands/Skills 两个 catalog 的并集；`turn/start` 的 slash 文本拦截（现仅匹配 Commands catalog，app-server-host.ts:2995）同步扩到并集，保证用户手敲 `/skill-name args` 与点击走同一条执行路径。不新增第二条执行 RPC，不新增 raw-RPC 透传。
- Renderer 在 Composer 左侧现有 Harness Commands 按钮旁新增独立 **Skills 按钮 + popover**（顶部带过滤输入框），并绑定 `Cmd/Ctrl+Shift+S` 快捷键。两个按钮彼此独立：Commands 继续只放静态 native 命令，Skills 只放动态枚举项。
- 未实现该 capability 的 Harness（Pi、Grok、OMP、DeepSeek、OpenCode、Antigravity）catalog 为空，Skills 按钮自动隐藏。

## Capabilities

### New Capabilities

- `harness-skill-catalog`: 从 Harness 原生枚举接口发现 skill，投影为可检查、可执行的 catalog，并在原生侧变化时刷新。

### Modified Capabilities

- `harness-command-capabilities`: 明确"来自 Harness 原生枚举 API 的项属于 native availability"这一例外；允许同一 Thread 存在相互独立的第二个命令 catalog（Skills），且两个 catalog 不得互相混入。

## Impact

- `packages/adapters/claude-code`：`sdk-transport.ts`（settingSources、`supportedCommands()`、`commands_changed` 分支）、`claude-code-adapter.ts`（skill catalog 投影与执行分派）。
- `packages/harness-adapter`：session capabilities 增加可选 `skills`。
- `packages/shared-contracts`：无新增 schema（复用 `threadCommandsInspectParamsSchema` 与 `harnessCommandCatalogSchema`）。
- `packages/host-runtime`：`app-server-host.ts` 增加 skills inspect 路由、`command/execute` 并集校验与 `turn/start` 拦截并集。
- `packages/renderer-extension`：新 `renderer-harness-skill-control.ts`、composer 挂载、本地化、binding probe。
- `docs/harness-command-integration.md`：补充 skill 接入路径与"Renderer 仍不得解析 SKILL.md"的边界重申。
- 行为风险：`settingSources` 变更影响**所有** Claude Code Thread 的上下文（见 design 的 Risks）。
- 不改动 Rust workspace、不改 delegation 控制面、不引入 skill 白名单管理 UI。
