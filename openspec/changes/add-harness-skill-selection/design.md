## Context

Claude Agent SDK（`@anthropic-ai/claude-agent-sdk@0.3.220`）已经把 skill 的完整生命周期暴露为可编程接口：

- `Query.supportedCommands(): Promise<SlashCommand[]>` —— 返回当前 session 可用的 skill/command 列表，`SlashCommand = { name, description, argumentHint, aliases? }`。
- `Query.initializationResult(): Promise<SDKControlInitializeResponse>` —— 其中 `slash_commands: string[]` 与 `skills: string[]` 分别标识内置命令与 skill，是"哪一项属于 skill"的天然权威分界。
- `SDKCommandsChangedMessage`（`type: "system", subtype: "commands_changed"`）—— 会话中途变化（例如 agent 进入子目录后动态发现 skill）后的全量 push，文档规定 REPLACE 语义。
- `Options.skills?: string[] | "all"` —— session 级启用白名单；omitted 时沿用 CLI 自身默认（发现即对模型可用）。
- `Options.settingSources` —— 文档明确 "Must include `'project'` to load CLAUDE.md files"。当前 `sdk-transport.ts:422` 与 `:891` 传 `["user"]`。

现有 Host 侧管线已经具备执行本能力所需的全部机制：`harnessCommandCatalogSchema`（strict，字段 `id/invocation/label/description/argumentMode`，ID regex `^[A-Za-z0-9._:-]+$`）、`codexhost/thread/commands/inspect` 与 `codexhost/thread/command/execute` RPC、Composer 的独立 Harness Commands popover（`renderer-harness-command-control.ts`，`root.hidden = commands.length === 0`），以及"命令按 ID 执行、不作为 Host text Turn 提交"的既有投影通路。

## Goals / Non-Goals

**Goals:**

- 用户在 Codex Desktop 的 Claude Code Thread 中，通过独立的 Skills 按钮或快捷键发现并显式调用当前 session 的原生 skill。
- 点击 skill = 显式装载进本轮：作为一次真实 Turn 提交（携带可选参数文本），走完整流式/工具/审批/取消/历史通路。
- skill 的发现、启用与解析全部由 Claude CLI 进程负责；CodexHost 不读磁盘、不解析 SKILL.md。
- CodexHost 中的 Claude Code 上下文行为对齐 Claude Code CLI（项目 CLAUDE.md、项目 skills）。
- 契约保持 Harness 中立：其他 Harness 因无 skill 枚举接口而 catalog 为空、控件隐藏。

**Non-Goals:**

- 不做 skill 启用/禁用白名单管理 UI（`skills` 选项保持 omitted，即 CLI 默认全量可用）。
- 不做 per-skill 元数据浏览（不展示 SKILL.md 正文、不预览文件）。
- 不为其他 Harness 发明 skill 支持。
- 不开放任意字符串命令透传（保持 `harness-command-capabilities` 现有禁令）。
- 不改 delegation 控制面的 skill 语义。

## Decisions

### 复用 command 通路，不新建 skill 抽象（方案 A）

skill 在 Claude 原生层就是 slash command。`SlashCommand` 的四个字段可无损投影进现有 `HarnessCommandDescriptor`：

```text
id           = "claude.skill." + name        // 点号与插件限定名的冒号均通过现有 ID regex
invocation   = "/" + name
label        = name
description  = description
argumentMode = argumentHint 非空 ? "text" : "none"
```

执行体与 `/compact` `/init` `/recap` 完全同款：`transport.runTurn("/" + name + (args ? " " + args : ""), …)`，即一次真实 user message Turn，由 Claude CLI 自己把 slash 解析为 Skill 工具调用。

曾考虑新开 `HarnessSkillCapability` + `skill/execute` RPC 的独立能力面（方案 B），契约更纯，但需要撑大 5 个包的中立接口只为一个 Claude 专属能力，违反"不为单一调用方造通用抽象"。被否。

### 区分 skill 与内置命令的权威来源

不靠命名启发式。主路径用 `Query.reloadSkills()`：control-channel 的原生 skills 枚举，15ms 级返回、名单里只有 skills（真机验证无 compact/clear 等内置命令），且在首条 user message 之前即可调用。旧版 CLI 无 `reloadSkills` 时回退到 `supportedCommands()` ∩ stream init `skills` 名单（实现期假定的方案；真机验证发现 CLI 直到第一条 user message 入队才 flush init，control 调用也无法提前逼出，故新 Thread 首消息前 inspect 会拿到空目录——因此回退仅作兼容，不作主路径）。`initializationResult().commands` 不可用：真机验证确认它混入 built-in 命令且无判别字段。`/compact` 等内置命令继续留在静态 `claudeCommandCatalog`，两个按钮内容互斥。

### `settingSources` 对齐 CLI

`["user"]` → `["user", "project", "local"]`，`sdk-transport.ts` 两处（主 transport 与子代理/warm transport 的选项构造）同时修改。这是本变更中唯一的非增量行为改动：所有已存在和新建的 Claude Thread 都会开始加载项目 CLAUDE.md 与项目 settings。选择不加开关：可回退性由 git revert 提供，加开关会把配置面分裂成第二真相源。

### Skills 与 Commands 是两个独立控件

按已确认的产品决定：现有 Harness Commands 按钮与其 popover 完全不变；新增 Skills 按钮（同区域、紧邻）拥有自己的 popover，顶部带过滤输入框（skill 数量可达数十条），键盘导航与焦点管理照抄现有 popover 的实现模式。`Cmd/Ctrl+Shift+S` 在 document capture phase 打开该 popover（precedent：`renderer-model-picker.ts:508`），仅当 skills catalog 非空时响应。

### Host 侧只扩"发现"，不扩"执行"

- 新增 `codexhost/thread/skills/inspect`（params 复用 `threadCommandsInspectParamsSchema`，result 复用 `harnessCommandCatalogSchema`）。
- 执行仍走 `codexhost/thread/command/execute`：command ID 全局路由到 owning Adapter，Adapter 内部按 `claude.skill.` 前缀分派到 skill 执行体。未知 ID 拒绝、参数在命令边界校验、busy session 拒绝——全部沿用现有 requirement。
- `commands_changed` push 到达后，Renderer 侧的失效策略与现有 catalog 刷新通路一致：Thread 获得新 catalog 即 REPLACE。

### 错误处理

- `supportedCommands()` 失败（旧版 CLI 无此接口）→ skills capability 视为不可用，catalog 为空，不报错、不阻塞 Turn。
- skill 执行中 Claude CLI 返回未知命令错误 → 作为该 Turn 的正常失败投影（有原生 error 通路），Host 不预校验参数内容。
- Session resume 路径同样在 open 后拉取 catalog；resume 失败沿用现有 transport 故障处理。

## Risks / Trade-offs

- **`settingSources` 行为跳变**：项目 CLAUDE.md 首次进入 CodexHost 的 Claude Thread 上下文，可能改变模型行为、增加 token 消耗、或让仓库里不可信的 `.claude/settings.json` 生效。接受：这就是"在 Desktop 里用 Claude Code"的默认含义；release notes 需明示。
- **任意仓库文件驱动 UI**：项目 skills 会出现在按钮列表里。缓解：列表只是枚举结果，点击才执行；执行前走既有工具审批通路（skill 内工具调用同样受 permission mode 约束）。
- **catalog 新鲜度**：REPLACE push 丢失时列表滞后。缓解：popover 打开时可低频 refresh（实现期决定是否需要）。
- **ID 命名空间**：skill 名理论上可与静态命令 ID 撞名（都叫 `claude.compact` 之类）。投影统一加 `claude.skill.` 前缀，与静态 `claude.compact` 命名空间天然分离；同名 skill（如两个 plugin 提供同名 skill）由 catalog schema 的 unique-ID superRefine 拒绝投影并在诊断中报告，不静默丢项。

## Migration Plan

单一发布：`0.5.x` 随包生效，无数据迁移。回滚 = revert 本 change；`settingSources` 回到 `["user"]` 即恢复旧上下文行为。Skills catalog 不落盘（mapping-store 无新记录类型），无清理负担。

## Open Questions

- `aliases` 是否需要展示（投影时并入 description 还是忽略）——实现期从简：忽略，CLI 语义由 Claude 侧保留。
- popover 打开时是否主动 refresh——首版被动（依赖 open 时拉取 + commands_changed），有反馈再加。
