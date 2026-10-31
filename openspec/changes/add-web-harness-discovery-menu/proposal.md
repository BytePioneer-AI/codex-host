# Proposal

## Why

Web 尚未展示当前会话的原生命令、Skills 和可选择的委派 Agent，用户需要记忆调用文本。复用现有 Host 能力和 Web 输入菜单，让这些能力可发现，同时不新增执行后端或草稿预热。

## What Changes

- 在 Web 现有 `/` 菜单中保留界面操作、原生命令与 Skills；`@` 和 `#` 完全等价，按委派 Agent、原生命令、Skills、工作区文件排序；移除加号入口。
- 原生命令与 Skills 仅在已创建、可输入的本地共享 external Thread 中提供；委派 Agent 同时支持未发送的 Web 草稿，复用已有 Harness 目录，不查询原生命令、不预热、不开放草稿查询通道。
- 无参数命令及菜单中的 `/compact` 直接执行并保留草稿、引用和附件；带参数命令与 Skills 按原生参数模式填入输入框后由用户发送。
- `@` 与 `#` 复用同一文件、原生命令、Skills 和委派 Agent source；`/` 仅共享原生命令与 Skills，保留既有文件及会话引用；选择委派 Agent 只插入包含目标 Harness 身份的引用，不切换当前 Harness、不发送消息、不立即创建任务。
- 补齐目录加载、静态目录提示、错误、忙状态、会话切换与重连的交互及聚焦测试。

## Decisions

- 复用 Web 的同一菜单能力；`@`、`#` 使用相同引用语法、候选与行为，工作区文件分组排最后；`/` 不提供委派与工作区候选，上传文件继续由界面操作提供。文件搜索复用 DSH 有界递归索引与模糊排序，只访问本地 Thread 或已选工作区草稿。命令和 Skills 共用 Host 目录，分类只采用原生元数据，不扫描或读取 Skill 文件。
- 委派候选复用 Web 已有、已确认就绪的会话 Harness 目录与展示顺序；身份使用实际 Harness ID，同名以 ID 区分，不把 `codex-cli` 替换成官方 `codex`，不硬编码额外目标。这是首版的 Web 可见范围，不声称等于 CLI 的全部委派目标。
- 选择 Agent 后沿用既有委派引用及普通消息提交语义，由当前 Agent 使用既有 Skill/CLI 委派；菜单不是任务启动器，也不是 Harness 切换器。
- 只做 Web 产品接线，保留 Host/Adapter 的命令过滤、权限、执行和委派语义；不增加客户端通道白名单、不新增模型/权限选择或任务跟踪入口。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `harness-command-capabilities`：新增 Web 已创建会话的命令/Skills 发现、搜索、选择、刷新及失败处理要求。
- `cross-harness-delegation`：新增 Web 委派 Agent 候选列表、身份明确的引用插入及无副作用提交边界。

## Impact

- Web 客户端：`apps/web-ui/packages/client/ui-codexhost`、现有 `ui-commands` / `ui-input-trigger` / `ui-conversation` 的必要接线，以及现有 Harness 目录消费方。
- Web 网关：`packages/web-server` 的薄目录/执行适配；复用 `codexhost/thread/commands/inspect`、`codexhost/thread/command/execute` 和普通消息提交。
- 复用 `shared-contracts` 的命令目录及委派引用公共导出；不新增依赖、持久化格式或 Host/Adapter 实现。
- 扩展 Web 隔离网关/浏览器测试，维护 `docs/product/standalone-web.md` 与命令接入文档；不改变 Desktop 行为。
