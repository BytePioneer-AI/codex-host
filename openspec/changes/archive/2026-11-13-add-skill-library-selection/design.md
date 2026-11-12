# Design

## Context

- 外部 Harness 只收文本：`externalTurnInputText` 把 `input` 合并为一个字符串，Adapter 契约 `TurnStartCommand.input` 只有 `{ type: "text" }`。
- 现有 Skill 链路：Adapter live 目录以 `kind: "skill"` 上报；Web `harness-discovery.tsx` 与 Desktop `renderer-delegation-mention.ts` 插入命令 carrier；Host `restoreHarnessCommandMentions` 把首个 carrier 挪到开头，经 `#beginExternalCommand` 作为临时命令 Turn 执行。
- 官方 Codex 的 Skill：Host 读 `skills/list`，提交时附加 `{ type: "skill", name, path }`，Codex 核心读取并注入正文。本变更不改动这条路径。
- Web 已有工作区文件索引（`packages/web-server/src/file-references.ts`）采用"先返回已有索引，超过 2 秒后台重建"的方式，与本设计一致。

## Decisions

### 索引归 Host Runtime

Web 与 Desktop 都需要同一份结果，Desktop Renderer 只能经 Host 方法取数，因此索引由 Host Runtime 持有。扫描、解析、索引与刷新逻辑放在新的独立包，Host 只负责触发时机与对外接口。放弃把索引放进 web-server：Desktop 无法共用。

### 目录清单集中、数据化

清单写在 Skill 库包内，按来源列出全局目录与相对项目的目录，每条带展示标签。首版只收录已有证据的目录：

| 来源 | 全局 | 项目 |
| --- | --- | --- |
| 通用 | `~/.agents/skills` | `.agents/skills` |
| Codex | `$CODEX_HOME/skills`（默认 `~/.codex/skills`） | `.codex/skills` |
| Claude Code | `~/.claude/skills` | `.claude/skills` |
| Pi | `~/.pi/agent/skills` | `.pi/skills` |
| OpenCode | `~/.config/opencode/skills`、`~/.config/opencode/skill` | `.opencode/skills`、`.opencode/skill` |
| DeepSeek Harness | — | `.dsh/skills` |

### Host 接口

- 查询：`codexhost/skills/list`，参数为 `threadId` 或 `cwd`（都缺省时只返回全局），结果含 `revision`、`complete`、`skills[]`（`name`、可选 `description`、`path`、`scope: "project" | "global"`、`source` 展示标签）与可选 `warnings`。
- 通知：`codexhost/skills/changed`，携带变化的工作区（全局变化不带）；收到后由打开着的菜单重新查询。
- 契约放在 `shared-contracts`，保持浏览器安全。

### 刷新参数（首版起点，实现时以实测调整）

| 参数 | 值 |
| --- | --- |
| 递归深度 | 6 |
| 每个目录候选子目录上限 | 2,000 |
| frontmatter 读取上限 | 64 KiB |
| 进程级文件操作并发 | 8 |
| 工作区索引上限 | 32（最久未用者淘汰） |
| 新鲜期 | 10 秒 |
| 首次扫描最长等待 | 1 秒 |

### 引用格式与识别

规范文本为 `[$<name>](<绝对路径> "Read this skill")`，路径含空白或括号时用 `<...>`。chip 识别规则：标签以 `$` 开头，目标是以 `/SKILL.md`（Windows 为 `\SKILL.md`）结尾的绝对路径。Web 直接插入规范文本。Desktop 若无法用原生 Composer 直接产生规范文本，可插入一个 Desktop 专用 carrier，由 Host 在外部 Thread 的 `turn/start`、`turn/steer` 与排队写入前原位还原为规范文本；外部 Harness 收到的永远是规范文本。

### 删除旧链路

- `harness-adapter`：`LiveHarnessCommand` 与排除规则不再区分 Skill。
- 各 Adapter：依据各自原生元数据丢弃 Skill 条目，不再输出 `kind: "skill"`。
- Web 与 Desktop：外部 Thread 的命令行不再有 Skill 分组来源；Skills 分组只来自 Skill 库。
- `kind` 字段与 `$` 形式的命令 carrier 只保留给官方 Codex。

## Risks / Trade-offs

- [模型不读文件] → 链接标题给出简短指令；这是软保证，已接受。
- [读取全局 Skill 触发 Harness 审批] → 不处理，按 Harness 自身权限行为呈现。
- [手工 `/skill名` 被拒绝] → 已接受；用户改用菜单或 `$` 引用。
- [Desktop 用户消息无法渲染为 chip] → 实测后若不可靠，停止并报告，不用不稳定的 DOM 改写硬做。

## Open Questions

- Kimi Code、Qoder、CodeBuddy、Cursor CLI、Kiro CLI、Grok、Copilot、Hermes、OMP 的 Skill 目录未核实，首版不收录，后续逐个补充。
