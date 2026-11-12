# Skill 库

外部 Harness 会话里的 Skill 由 Host 统一发现，用户在菜单中选用。选中后提交一段指向 `SKILL.md` 的文本链接，Agent 自己读取文件。外部 Harness 不接收结构化的 Skill 输入，也不经过命令目录。

官方 Codex Thread 不使用 Skill 库，仍走 Codex 原生 Skill 目录与 `{ type: "skill", name, path }` 输入，见 [Harness 命令集成](harness-command-integration.md)。

## 来源

目录清单集中在 `packages/skill-library/src/directories.ts`，只收录已核实的约定：

| 来源 | 全局 | 项目 |
| --- | --- | --- |
| Agents | `~/.agents/skills` | `.agents/skills` |
| Codex | `$CODEX_HOME/skills`（默认 `~/.codex/skills`） | `.codex/skills` |
| Claude Code | `~/.claude/skills` | `.claude/skills` |
| Pi | `~/.pi/agent/skills` | `.pi/skills` |
| OpenCode | `~/.config/opencode/skills`、`~/.config/opencode/skill` | `.opencode/skills`、`.opencode/skill` |
| DeepSeek Harness | — | `.dsh/skills` |

- 全局目录总是显示，与当前 Harness 无关。
- 项目目录从会话工作目录向上，逐级扫描到最近一个含 `.git`（目录或文件）的祖先为止；找不到 `.git` 时只扫描工作目录本身。
- 其他 Harness 的目录尚未核实，不在清单内。新增来源只改清单。

## 扫描

- 每个根目录向下递归，最多 6 层；某个目录含 `SKILL.md` 时即视为一个 Skill，不再向下。
- 跳过以 `.` 开头的目录及 `node_modules`、`vendor`，因此 `~/.codex/skills/.system` 里的 Codex 内置 Skill 不显示。
- 跟随符号链接，按真实路径防止循环；每个目录最多处理 2,000 个子目录，超出部分保留上次结果并给出告警。
- 只读取 `SKILL.md` 开头 64 KiB 的 YAML frontmatter。`name` 必填，且不能含空白或方括号；`description` 可选。不读取正文。
- 全部使用 `node:fs/promises`，整个进程同时最多 8 个文件操作。

## 索引与刷新

- 索引只在 Host Runtime 内存中，不落盘，不监听文件变化。
- Host 启动后在后台建立全局索引；外部 Thread 注册或 Web 草稿得到工作目录时，在后台建立该工作区的索引。工作区索引最多 32 个，淘汰最久未用者。
- 查询只读内存。索引超过 10 秒未校验时，查询照常返回现有结果，同时在后台校验。
- 校验会重新列出每个已访问的目录，检查每个子目录的 `SKILL.md`（包括之前不存在的），`mtime` 和大小都未变的文件沿用已解析的结果。
- 同一索引同时只运行一次扫描。已被淘汰的索引不再发布结果。
- 首次扫描未完成时，查询最多等待 1 秒，之后返回已有的部分结果并标记 `complete: false`。
- 结果变化时，全局版本号 `revision` 加一，并发出 `codexhost/skills/changed`：工作区变化带 `cwd`，全局变化不带。
- 只有确认文件或目录不存在时才移除对应的 Skill；权限、I/O 等错误保留上次结果并附带告警，下次校验时重试。一个目录失败不影响其他目录。

## 去重与同名

按 `SKILL.md` 的真实路径去重。名称相同但路径不同的 Skill 全部保留，各自标出来源与路径。结果中项目 Skill 排在全局 Skill 之前，各组内按名称排序。

## Host 接口

契约在 `packages/shared-contracts/src/skills.ts`。

- `codexhost/skills/list { threadId? | cwd? }` → `{ revision, complete, skills, warnings? }`。每个 Skill 含 `name`、`description?`、`path`、`scope`（`project` 或 `global`）和 `source`（来源展示名）。两个参数都不传时只返回全局结果。
- `threadId` 必须指向本地外部 Thread，且不是子会话。Host 只读取所有权记录里的工作目录，不打开、不恢复 Session，也不启动 Harness。
- 共享 Host 模式下，Desktop 侧的 Host 进程不建立自己的索引，查询和变化通知都来自共享 Host。

## 引用格式

规范文本由 `formatSkillReference` 生成（`packages/shared-contracts/src/skill-reference.ts`）：

```text
[$eli5](/Users/me/.agents/skills/eli5/SKILL.md "Read this skill")
```

路径含空白或括号时写成 `<路径>`。识别只看文本：链接标签以 `$` 开头，目标是以 `SKILL.md` 结尾的绝对路径。识别不查目录，Skill 被删除后，旧消息里的引用仍显示为 chip。外部 Harness 收到的始终是这段规范文本，同一条消息里可以有多个引用，位置保持不变。

## Web

- Skills 分组出现在 `/`、`@`、`#` 菜单中，适用于本地外部 Harness 的已创建会话和已选 Harness 的草稿。官方 Codex、只读子会话和远程来源不显示。
- 打开菜单时查询一次，搜索在本次结果中按名称和描述过滤；收到变化通知或重新连接时，打开着的菜单重新查询。
- 选中后直接插入规范文本，输入框中显示为 Skill chip。复制得到完整链接，粘贴规范文本同样显示为 chip。
- 用户消息、发送回显和排队预览从文本识别引用并显示为 chip。
- 有扫描告警时，分组末尾显示一行不可选的“部分 Skill 无法读取”，明细在说明里。查询失败时显示可重试的错误，不影响命令和委派候选。

## Desktop

- `#` 菜单中外部 Thread 与草稿的 Skills 分组来自 Skill 库，收到 `codexhost/skills/changed` 后刷新打开着的菜单。
- Desktop 原生输入框不会把粘贴的规范文本识别为 chip，因此选中 Skill 时插入原生 mention carrier `subagent://codexhost-skill.<编码后的名称与路径>`，并只为这类 carrier 加上 Skill 图标样式。在外部 Harness 输入框中粘贴规范文本时转换为 carrier，复制时还原为规范文本。
- Host 在外部 Thread 的 `turn/start`、`turn/steer` 和排队写入前，把消息里的全部 carrier 原地还原为规范文本，不移动位置。
- Desktop 用户消息不显示 Skill chip：刚发送时显示为 `@名称` 普通文字，历史中保存的是规范文本原文。

## 手工输入

外部 Harness 的 live 命令目录不含 Skill。目录就绪后，手工输入的 `/某Skill名` 会按未知命令被拒绝；应改用菜单或直接写规范文本。

## 边界

- Host 与 Renderer 不读取、不注入 Skill 正文，只提供路径；Agent 是否读取由模型决定，链接标题只是简短提示。
- 读取全局 Skill 是否触发审批，由各 Harness 自身的权限设置决定。
- 不提供按 Harness 控制可见性、原生 Skill 标记或 Skill 管理面板；这些能力在此索引之上另行实现。
