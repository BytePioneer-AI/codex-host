# Proposal

## Why

外部 Harness 的 Skill 现在混在原生命令目录里，选中后走命令执行链路：真实对话被当作临时命令，只认第一个、被挪到开头，冷启动时还看不到项目 Skill。用户主动选 Skill 只需要把 SKILL.md 的位置告诉 Agent，不需要 Harness 认识它。

## What Changes

- 新增 Skill 库：Host 在后台异步扫描本机全局 Skill 目录与当前工作区项目 Skill 目录，在内存中维护索引并保持新鲜；提供只读查询与变化通知，查询不等待扫描、不启动 Harness。
- Web 与 Desktop 的外部 Harness 会话（含已选工作区的草稿）从 Skill 库展示 Skills 分组，可搜索；任何 Skill 都可用于任何外部 Harness。
- 选中 Skill 插入引用，提交文本为 `[$<name>](<SKILL.md 绝对路径> "Read this skill")`，留在用户放置的位置，按普通消息提交；气泡显示为 Skill chip。
- **BREAKING** 删除外部 Harness 的 Skill 命令链路：Adapter 不再把原生 Skill 放进命令目录，Host 目录与 Web/Desktop 菜单不再有外部 Harness 的原生 Skill 条目；手工输入原生 `/skill名` 按未知命令处理。
- 官方 Codex Thread 不变，继续使用 Codex 原生 Skill 目录与 Skill 输入。

## Decisions

- 主动选用与 Harness 无关：Skill 库回答"本机有哪些 Skill"，不回答"某 Harness 原生加载哪些"。目录清单集中在 Skill 库，与已安装的 Harness 插件无关；放弃由各 Adapter 声明目录。
- 只传文本：外部 Harness 只收文本，Skill 以带路径的 Markdown 链接表达，由 Agent 自行读取；不新增结构化输入字段，也不读取或注入 Skill 正文。
- 同名 Skill 全部保留并标注来源，项目组在前；不定义跨 Harness 的覆盖规则。
- 被动可见性（控制 Harness 原生加载哪些 Skill）与原生标记不在本次范围。

## Capabilities

### New Capabilities

- `skill-library`: 本机 Skill 的发现、索引、刷新与查询，以及外部 Harness 会话中的 Skill 选择、提交格式与展示。

### Modified Capabilities

- `harness-command-capabilities`: 命令目录与命令链路不再包含外部 Harness 的 Skill；Web 菜单的 Skills 分组改由 Skill 库提供。

## Impact

- 新增 Workspace 包（Skill 扫描与索引）；`shared-contracts` 新增 Skill 查询与变化通知契约。
- `host-runtime`：持有索引，提供查询与通知。
- `harness-adapter` 及 Claude Code、Pi、OMP、Grok、Kiro CLI、CodeBuddy、Hermes Adapter：移除原生 Skill 的命令目录条目。
- `web-server`、`apps/web-ui`（ui-codexhost、ui-chat、ui-primitives）：Skills 分组、引用插入与气泡展示。
- `renderer-extension`：Desktop `#` 菜单 Skills 分组与引用插入。
- 文档：`docs/architecture/harness-command-integration.md`、`docs/product/standalone-web.md`。
