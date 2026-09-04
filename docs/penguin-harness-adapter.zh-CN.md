# Penguin Harness 适配器

状态：实验性接入，随 CodexHost 一起构建，不会修改系统里的 Penguin 安装包。

## 本地版本身份

这条开发线统一称为 **Penguin Local r1**，基于 CodexHost 官方 `v0.4.4`。`0.4.5` 到 `0.4.10` 是本机排障期间使用过的 npm 兼容包版本，不是 CodexHost 官方版本，也不应继续作为这项适配工作的产品版本号。

后续维护只记录两个维度：

- 上游基线：当前从哪个 CodexHost 官方版本合并而来；
- 本地修订：`Penguin Local rN`，只在 Penguin 适配内容发生变化时递增。

现有 `0.4.10` 包保留为 `Penguin Local r1` 的安装兼容包，避免正在使用的本机更新链路失效。上游发布新版本时，应先把本分支 rebase/merge 到新基线并通过本文的验收项，再更新基线记录；不再通过连续增加 `0.4.x` 假装追赶官方版本。

## 为什么需要这个修改版

官方 CodexHost 当前没有 Penguin Harness 适配器。仅让启动器“识别到 Penguin”不够：Codex Desktop 还需要完整的 Harness Adapter，把 Penguin 的 Project、Agent、Model、Session、流式事件、工具审批和结束状态转换成 CodexHost 协议。否则会出现能选 Agent 但不能选模型、工具完成后对话仍在运行、停止聊天失败等半接入状态。

`Penguin Local r1` 完成了以下最小闭环：

- 把 Penguin Adapter 注册进 Host Runtime、构建产物和 npm 发布包；
- 发现真实 Penguin CLI，连接或按需启动本地回环 Server，并处理本地 token 轮换；
- 读取 Project、Agent、模型与 Thinking 目录，在创建 Thread 时选择模型；
- 创建/恢复 Penguin 原生 Session，映射历史、用量、文本、思考、工具调用和工具输出；
- 映射权限模式、工具审批和取消操作；
- 补齐 Codex Desktop 的 Agent 图标、中文名称、Agent/Model 选择器和 Renderer 绑定；
- 当 Penguin 漏发终止事件时，以原生 Session 的 `idle` 状态和最终历史收口 Host Turn；
- 对发给 Host 的事件做不可变快照，避免流式对象被后续修改后触发 `Host textual Item completion does not match its append updates`，导致任务已完成但界面无法停止；
- 增加 Adapter、协议、Renderer、Host Bundle 和发布包回归测试。

这不是模型路由代理，也不会修改官方 Codex 模型出口。它只增加一个可被 CodexHost 选择的 Agent Harness。

这个适配器把已经安装的 Penguin Harness 接到 CodexHost 的 `HarnessAdapter` 边界。Penguin 仍然负责自己的 Agent Loop、工具、权限、模型凭据和原生 Session；CodexHost 只负责把它显示为一个可选择的 Harness，并把原生事件投影到桌面界面。

## 使用前提

- 本机已经可以直接运行 Penguin CLI；适配器不会替你安装 Penguin 或配置 Provider 凭据。
- CodexHost 与 Penguin 使用同一个 Penguin 数据根目录时，适配器可以看到 Penguin 的项目、Agent 和模型目录。
- 模型列表来自 Penguin 的 `/api/projects/:projectId/models`，不会把 API key 或其他凭据返回给 Renderer。

## 启动与连接

适配器按下面的顺序连接 Penguin：

1. 使用显式 Endpoint（如果配置了）。
2. 读取 Penguin 数据根目录中的 `server.lock`，复用已经运行的本地 Penguin Server。
3. 如果没有运行中的 Server，启动由适配器管理的本地进程，监听 `127.0.0.1`，然后连接它。

本地 Server 重启并轮换 `api-token` 后，适配器会在第一次 401 响应时重新读取同一数据根目录中的 token 并重试一次。

适配器关闭时，只会停止自己启动的 Server；如果连接的是用户原本已经启动的 Penguin Server，不会替用户关闭它。因此可以继续单独使用 Penguin 的桌面或 Web UI。

适配器和独立 Penguin UI 使用同一个原生 Session 存储时，在 CodexHost 中创建的 Session 可能会出现在 Penguin UI 的 Session 列表中。这是共享原生数据的结果，不是 CodexHost 复制了一套对话。两个界面不要同时向同一个 Session 提交任务。

## CodexHost 中的能力

当前已接入：

- Penguin Harness 发现、项目/Agent/模型目录读取；
- 创建和恢复 Penguin 原生 Session；
- 流式文本、思考过程、工具调用和工具输出；
- 工具审批：允许一次、允许本 Session、拒绝；
- Session 级权限模式：Always ask、Read only、Allow all、Deny all；
- Thinking 级别选择；
- 取消正在运行的 Task；
- 原生历史读取和 Host Thread 快照；
- CodexHost 的模型 Ref 与 Penguin 的 `{provider, modelId}` 双向映射。

有一个重要边界：Penguin 当前把 Provider/Model 固定在 Session 创建时，适配器因此只在创建新 Thread 时提供模型选择；已经打开的 Penguin Session 不显示“原地切模型”能力。要换模型，应创建新 Thread 或新 Session。

当前不宣称支持：Fork、回滚上一轮、Penguin Question 交互、原生 File Diff 和 Penguin 子 Agent 映射。缺少这些能力时，CodexHost 会按不支持处理，不会伪造成功结果。

因此，“日常创建对话、选模型、执行工具、审批、停止和恢复”已有完整闭环；它还不是 Penguin 原生客户端的全功能替代品。

## Session 与工作目录

CodexHost 中每个新 Thread 都会创建一个独立的 Penguin 原生 Session。这是隔离取消、历史和工具状态所必需的，不能把多个并行对话安全地合并为同一个 Session。

三个概念需要分开：

- `Project / Agent` 决定 Session 归档分组。默认都进入 `default_project / default_agent`；可以用 `CODEXHOST_PENGUIN_PROJECT_ID` 和 `CODEXHOST_PENGUIN_AGENT_ID` 固定到指定分组。
- Codex 新对话选择的工作区决定工具实际操作哪个本机文件夹；创建 Session 时会作为 `workspace` 传给 Penguin。
- Session ID 由 Penguin 创建。新 Thread 会生成新 ID；恢复同一 Codex Thread 时会继续映射到原 Session。

所以不需要、也不能通过首条提示词要求 Agent “把 Session 移到某个文件夹”：Session 在收到提示词之前就已经创建。正确做法是先在 Penguin 中建立专用 Project/Agent，再在启动 CodexHost 的环境中固定上面两个 ID。这样 Session 仍然一对话一个，但会统一归档在：

```text
~/.penguin/data/<project>/agents/<agent>/traces/<date>/
~/.penguin/data/<project>/agents/<agent>/scratchpad/<session-id>/
```

如果你的目的只是让任务文件集中在一个项目目录，新建 Codex 对话时选择那个工作区即可，不需要改变 Penguin Session 存储。

### 配置一个专用 Penguin Agent

下面是当前 CLI 可以直接执行的最短流程。它不会删除或迁移现有的 `default_agent`：

```bash
# 1. 查看可用 Project，记录目标 projectId
penguin project ls --json

# 2. 查看该 Project 现有 Agent
penguin agent ls --project-id default_project --json

# 3. 创建只给 CodexHost 使用的 Agent
penguin agent create \
  --project-id default_project \
  --agent-id codex_host_agent \
  --name "Codex Host Agent" \
  --description "由 CodexHost 调用的独立 Penguin Agent" \
  --json

# 4. 再次确认创建结果，记下 agentId
penguin agent ls --project-id default_project --json
```

当前 CLI 对 `agent-id` 的要求是只使用字母、数字和下划线，因此使用 `codex_host_agent`。本机当前已创建的专用组合是：

```text
CODEXHOST_PENGUIN_PROJECT_ID=default_project
CODEXHOST_PENGUIN_AGENT_ID=codex_host_agent
```

要让路由控制台和桌面人工启动入口都使用这组 ID，需要把这两个非敏感环境变量放进它们各自的启动环境中：

- 控制台服务：`~/.codex-route-orchestrator/com.codex.route.ui.plist` 的 `EnvironmentVariables`；
- Host 人工启动：桌面的“更新并启动 Codex Host（人工确认）”脚本中，`PATH` 设置之后、第一次调用路由编排器之前。

配置完成后，重新加载路由控制台服务，再在没有活动任务时手动停止并重新启动 codex-host。之后新建的 Codex Thread 才会进入指定 Agent；已经存在的 Thread 不会被强行迁移。

如果还要让 Project 本身也独立，先在 Penguin Web/Desktop 的项目管理页创建一个 Project，再用新 Project 的 `projectId` 重复上面的 Agent 创建步骤。当前 CLI 只有 `project ls`，没有创建 Project 的命令，所以不要自行拼接 Project ID。

最后，在 Codex 新建对话时选择一个专用工作区，例如 `~/Documents/CodexHost-Penguin-Workspace`。这个目录是工具实际读写的位置，与 Session 归档目录不同；不要让多个同时运行的任务共用同一个工作区。

## 可选配置

只记录配置项名称，不记录 token 值：

| 配置项 | 作用 |
|---|---|
| `CODEXHOST_PENGUIN_COMMAND` | 指定 Penguin CLI 的真实可执行文件路径。 |
| `CODEXHOST_PENGUIN_ENDPOINT` | 指定 Penguin API Endpoint；不配置时优先使用本地 Server。 |
| `PENGUIN_API_URL` | Penguin 原生支持的 API Endpoint 别名；仅在没有 `CODEXHOST_PENGUIN_ENDPOINT` 时使用。 |
| `CODEXHOST_PENGUIN_PROJECT_ID` | 指定默认 Project；不配置时使用 Penguin 返回的默认/第一项。 |
| `CODEXHOST_PENGUIN_AGENT_ID` | 指定默认 Agent；不配置时使用 Penguin 返回的默认/第一项。 |
| `PENGUIN_PROJECT_ID` / `PENGUIN_AGENT_ID` | Penguin 原生的 Project / Agent 配置别名。 |
| `CODEXHOST_PENGUIN_PORT` | 适配器自动启动本地 Server 时使用的端口。 |
| `PENGUIN_HOME` | 指定 Penguin 数据根目录。 |
| `PENGUIN_API_TOKEN` | 连接远程 Penguin Server 时使用；本地回环连接会读取同一数据根目录的 `api-token`，只在内存中使用，不写入日志。 |

如果 Finder 或桌面启动器没有继承完整 PATH，可以优先设置 `CODEXHOST_PENGUIN_COMMAND`，让 Host 明确使用真实的 Penguin CLI 路径。

## 隔离与风险边界

- 适配器不会改写官方 Codex 的可执行文件、模型路由或账号配置。
- Penguin 的 Provider 凭据仍由 Penguin 管理；CodexHost 不读取、复制或记录凭据值。
- 自动启动的是 Penguin 自己的本地 Server，不是另一个隐藏的模型代理。
- 同一个 Penguin 数据根目录会带来原生 Session 可见性共享；如果需要完全隔离，应给适配器配置独立的 `PENGUIN_HOME`，并在该根目录中单独配置项目、Agent 和 Provider。
- 这是第三方适配器。Penguin API 字段或事件变化时，可能需要更新适配器；CodexHost 更新本身不会替用户维护 Penguin API 兼容性。

## 从源码验证

在 CodexHost 源码目录执行：

```bash
npm install
npm run build:typescript
npx vitest run --config tests/vitest.config.js packages/adapters/penguin/test
```

这组测试使用合成的 Penguin API，不会启动本机 Penguin Server，也不会发起真实模型请求。

提交上游 PR 前还应运行仓库完整检查：

```bash
npm run check
```

并至少完成一次真实链路验收：创建 Penguin Thread、选择模型、完成一次纯文本任务、一次工具任务、一次需要审批的任务，确认出现且只出现一次 Turn completed，随后可以继续输入或停止会话。

## 建议的上游 PR 摘要

标题：`feat: add experimental Penguin Harness adapter`

PR 正文应重点说明：

1. Penguin 保留 Agent Loop、模型凭据、工具和原生 Session 所有权；CodexHost 只做协议适配和桌面呈现。
2. Adapter 使用 Penguin 本地 HTTP/SSE API，不读取或向 Renderer 暴露 Provider 凭据。
3. 模型只能在创建 Session 时选择，这是 Penguin 原生约束，不伪造运行中切换能力。
4. 终止判定同时兼容标准 `request_end` 和原生 Session 已 `idle` 的缺失事件场景。
5. Host 事件必须按值快照，不能把仍会被流式更新修改的对象引用交给消费者。
6. 当前明确不支持 Fork、回滚、Question、原生 File Diff 和子 Agent 映射；这些不应阻塞基础 Adapter 合并。
