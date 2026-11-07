# Codex CLI 能力清单

## 基本信息

| 项 | 内容 |
|---|---|
| Harness ID | `codex-cli` |
| 原生接口与传输方式 | 本地 `codex app-server` JSON-RPC stdio；Desktop 官方 Codex 路径独立 |
| 已验证的原生版本 | Codex CLI `0.161.0`：只读发现与元数据解析、ephemeral Thread 的 Fast 档位开关；映射导入使用临时库，真实续聊验收待验证 |
| 交付范围 | 既有仅 Web 的预装插件；此清单记录当前实现与验证缺口 |
| 参考插件 | 公共 `session-import` 元数据工具；不增加 Harness 专用 Host 路由 |
| 最后验证 | macOS：隔离协议夹具、插件冷加载、本机原生只读发现及临时库映射、ephemeral Thread 的 Fast 开关确认；无真实 Model 请求 |

## 能力

| # | 功能 | 必做 | 优先级 | 结论 | 实现位置 | 证据 | 备注 |
|---|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | 支持 | manifest.json | host-runtime/test/installed-harness-plugins.test.ts | 仅 Web |
| A2 | 工厂 | 必做 | P0 | 支持 | src/plugin.ts | test/process.test.ts | createHarnessAdapter |
| A3 | 检查 | 必做 | P0 | 支持 | src/plugin.ts | test/authentication-native.test.ts | 不预检查认证 |
| A4 | 创建 Session | 必做 | P0 | 支持 | src/session.ts | test/process.test.ts | 原生 thread/start |
| A5 | 执行 Turn | 必做 | P0 | 支持 | src/session.ts | test/process.test.ts | 原生 turn/start |
| A6 | 取消 | 必做 | P0 | 支持 | src/session.ts | test/authentication-native.test.ts | turn/interrupt；原生中断或失败终态先结算未完成 Item，保留已流出的内容 |
| A7 | 只读快照 | 必做 | P0 | 支持 | src/session.ts | test/authentication-native.test.ts | thread/read |
| A8 | 持久身份 + resume | 必做 | P0 | 支持 | src/plugin.ts、src/session.ts | test/process.test.ts | ID 引用，不复制原生历史 |
| A9 | 错误与并发 | 必做 | P0 | 受限 | src/plugin.ts、src/session.ts、src/rpc.ts | test/process.test.ts、test/authentication-native.test.ts | 普通恢复的 writer 冲突映射为可重试 sessionBusy；显式导入按 C6 处理；无原生 steering |
| A10 | 关闭 | 必做 | P0 | 支持 | src/plugin.ts、src/session.ts、src/rpc.ts | test/process.test.ts | 关闭进程与用量读取 |
| B1 | 切换 Model | 原生有则必做 | P1 | 支持 | src/session.ts | test/process.test.ts；configuration 声明 | 原生参数 |
| B1-Fast | 原生 Fast 服务档位 | 原生有则必做 | P1 | 支持 | src/model-selection.ts、src/plugin.ts、src/session.ts | test/fast-mode.test.ts；CLI 0.161.0 原生目录与 ephemeral Thread 开关确认 | 仅原生 serviceTiers 声明 priority 时提供 fastModel；创建、恢复与 Turn 传原生 model/serviceTier；切换等待 settings 通知 |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 支持 | src/session.ts | test/process.test.ts；configuration 声明 | 原生 effort |
| B3 | 权限模式 | 原生有则必做 | P1 | 支持 | src/session.ts、src/permission-modes.ts | test/process.test.ts | live；创建与恢复从原生审批策略和沙箱响应确认权限；自定义或缺失配置不冒充标准档位 |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 支持 | src/plugin.ts、src/session.ts | test/process.test.ts：隔离协议夹具 | unattended-full-access 映射为 danger-full-access / never；拒绝显式权限冲突及原生未确认；真实 Model 委派待验收 |
| B5 | Fork | 原生有则必做 | P1 | 不支持 | src/plugin.ts、src/session.ts | history.fork=false；open 拒绝 | 通用 Fork 不开放；导入的 writer 冲突由 C6 使用受控原生派生 |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 不支持 | src/plugin.ts、src/session.ts | history.forkAcrossCwd=false | 与 B5 相同 |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | 不支持 | src/plugin.ts、src/session.ts | history.rollbackLastTurn=false | 原生派生恢复尚未接入 |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | 支持 | src/items.ts、src/session.ts | test/items.test.ts | 公共 Item 投影 |
| B9 | 审批 | 原生有则必做 | P0 | 支持 | src/session.ts | test/authentication-native.test.ts | 原生请求与响应 |
| B10 | 提问 | 原生有则必做 | P0 | 支持 | src/session.ts | test/authentication-native.test.ts | requestUserInput |
| B11 | 原生 Subagent | 原生有则必做 | P2 | 受限 | src/items.ts | test/items.test.ts | 投影委派 Item；无独立子代理历史能力 |
| B12 | 自主 Turn | 原生有则必做 | P1 | 受限 | src/session.ts | turn.autonomous.started 投影 | 未声明完整 observe 能力，真实后台行为待验收 |
| B13 | 会话用量 | 原生有则必做 | P1 | 支持 | src/usage.ts、src/plugin.ts | test/account-usage.test.ts | 复用 Codex 原生用量读取 |
| B14 | 请求级计量 | 原生有则必做 | P2 | 待验证 | src/usage.ts | — | 不声称请求级验收完成 |
| B15 | 接收委派 | 必做（验证项） | P1 | 待验证 | src/plugin.ts、src/session.ts | — | 不以普通 create/resume 测试代替完整委派 |
| B16 | 向下委派 | 原生有则必做 | P2 | 待验证 | src/command.ts、src/plugin.ts | test/command.test.ts、test/delegation-environment.test.ts：创建、恢复、多会话环境隔离及 Desktop 路由清理 | 通过 Host 托管 Skill 发现 CLI；仅传递 CLI 路径、可选 Node 路径、Runtime 端点/令牌及 Host Thread ID；真实原生发现与调用验收待验证 |
| C1 | 展示元数据 | 必做 | P1 | 支持 | manifest.json、assets/icon.png | host-runtime/test/installed-harness-plugins.test.ts | Web 展示身份 |
| C2 | 手动安装指引 | 必做 | P1 | 受限 | manifest.json | links.installation | 官方文档链接，无内嵌安装步骤 |
| C3 | 版本检查与更新 | 必做 | P1 | 受限 | src/plugin.ts | 无 installation 方法 | 需用户在原生 CLI 管理 |
| C4 | 首次安装 | 可选 | P2 | 不支持 | src/plugin.ts | 无 install 方法 | 使用原生安装方式 |
| C5 | 自定义启动路径 | 条件必做 | P1 | 支持 | manifest.json、src/command.ts | test/command.test.ts | 拒绝 Desktop proxy/shim |
| C6 | 会话导入 | 可选 | P2 | 支持 | src/plugin.ts、src/codex-session-import.ts、src/import-session.ts、src/session.ts | test/process.test.ts、test/import-session.test.ts；host-runtime/test/codex-cli-harness.test.ts | 可恢复时沿用同一原生 ID；仅确认 writer 冲突时从最新 completed Turn 原生 Fork，新 ID 由 Host 提交后使用；原会话继续独立运行 |
| C7 | 全局用量统计 | 可选 | P2 | 不适用 | — | 独立 codex-usage 插件 | 不由执行插件重复拥有 |
| C8 | 账号额度 | 可选 | P2 | 支持 | src/account-usage.ts、src/plugin.ts | test/account-usage.test.ts | 原生 rateLimits |
| C9 | Desktop 原生目录刷新 | 可选 | P2 | 受限 | src/plugin.ts；Host 持久化与 Desktop 控制通道 | Host/Controller/Renderer 定向回归；Desktop 0.166.0-alpha.6 实机目录刷新 | 新建首个回合落盘后或导入派生 ID 提交后尝试一次；仅连接中的同 home Desktop，未运行、未就绪及失败均忽略，无补刷或重试 |
| D1 | Workspace / 构建 | 预装时必做 | P1 | 支持 | package.json、tsconfig.json | 根 tsconfig.json | 既有 Workspace |
| D2 | 预装清单 | 预装时必做 | P1 | 支持 | manifest.json | scripts/release/harness-plugins.json | 仅 Web |
| D3 | 加载测试 | 预装时必做 | P1 | 支持 | src/plugin.ts | host-runtime/test/installed-harness-plugins.test.ts | 不代表真实原生验收 |
| D4 | 文档 | 预装时必做 | P1 | 支持 | CAPABILITIES.md | docs/product/standalone-web.md | Codex CLI 与导入约束 |
| D5 | 其他 | 可选 | P2 | 不适用 | — | — | 不改变 Desktop 官方路径 |

## 受限与已知缺口

- A9：原生 steering 明确拒绝；Host 使用所有外部 Harness 的队列规则。
- A9：普通恢复遇到 `thread/resume` 的原生 `-32600` writer 占用错误返回 `sessionBusy`。Host 保留忙碌错误码并提示关闭其他客户端中的会话后重试；普通恢复不创建替代会话，释放占用后使用相同 Native Session ID 恢复。显式导入的派生规则见 C6；两条路径都不终止其他客户端或删除原生锁。
- B3：原生依据为 CLI `0.161.0` 生成的 `ThreadStartResponse` / `ThreadResumeResponse`：响应含 `approvalPolicy` 与 `sandbox`。仅匹配目录内的审批策略和沙箱类型；粒度化审批、外部沙箱及缺失字段不报告标准权限 ID。读取有效权限不等于选择权限，未显式选择时不追加 Turn 权限覆盖。既有 live 切换仍用于后续 Turn，未单独验证活动 Turn 内权限变化。
- B4：无人值守权限映射由隔离协议夹具验证；真实 Model 执行未验收。B15、B16：未完成完整双向委派验收，不声称完整委派支持。
- B11、B12：委派 Item 和自主 Turn 事件投影不等于完整子代理历史与自主能力交付。
- B1-Fast：没有 `serviceTiers` 元数据的旧 CLI 不提供 Fast，不从旧速度标签推导档位。普通选择显式清除 Fast；无配置提示的恢复保留原生档位。切换仅保证后续 Turn 使用确认的配置，未实测真实推理速度、计费或生产 Session 的 Fast 恢复；恢复由隔离协议夹具验证。原生设置确认超时或失效会关闭 Session，避免未知档位继续发送。
- B14：请求级计量尚未独立验收。
- C2、C3：提供官方安装链接与可自定义启动路径，没有插件内安装更新工作流。
- C6：Codex 的分页历史可将同一逻辑 Session 保存为多个原生 rollout 段；归并使用逻辑 Session ID，重复项与提交时的元数据以原生 thread/read 为准。导入先尝试原生 resume，只有明确的 writer 冲突才分页寻找最新 completed Turn，通过 thread/fork 的 lastTurnId 精确保留历史前缀；无完成轮、历史分页异常和其他恢复错误都不派生。副本不包含后续运行中或失败的轮次，不与源会话实时同步。原生 Fork 已返回新 ID 时，即使后续配置初始化失败也提交该 ID；发送 Fork 后结果未知则拒绝自动重试。导入使用有界 RPC，不发送 Prompt，不关闭源会话持有者。
- C9：目录刷新依赖当前 Desktop 内部服务，按已加载服务结构识别；发现失败直接忽略。只更新目录，不发 resume 或 Turn。CLI `0.161.0` 的空白 thread/start 尚无原生历史文件，因此新建通知在首个回合持久化后发送；预热、普通恢复和同 ID 导入不触发。真实 helper 验证已使现有 Fork 分支进入 Desktop catalog，自动 Host 触发由隔离集成覆盖，运行中的旧服务需更新构建后才具备新触发逻辑。

## 插件外改动

- 原生 ID 提交后的目录刷新需要通用发布通知：Adapter 可选 `onSessionPublished` 与插件上下文 `refreshNativeThreadCatalog` 保持原生归属在插件中；Host 仅在持久化成功后通知对应 Adapter，Desktop 控制包拥有内部目录服务绑定。现有 create/resume 返回值不能表达这个提交后时机。

- `tests/fixtures/codex-auth-peer.cjs`：隔离夹具提供原生 cursor 分页、权威元数据读取、分段逻辑历史、身份不一致与原生读取失败响应；支持精确 Turn 边界 Fork、已创建但响应丢失、配置及历史读取失败；支持服务档位目录、设置通知、设置拒绝、跨进程档位恢复及 Turn 中间通知；权限响应覆盖原生默认、自定义、缺失及显式选择不匹配。
- `packages/host-runtime/test/codex-cli-harness.test.ts`：公共导入事务、原生历史恢复与续写同一身份、Fast 目录和配置路由的回归测试；无 Host 生产分支。
- `docs/architecture/harness-session-import.md`：记录 Codex CLI 的逻辑身份归并与原生恢复约束。
- Web 通用导入页面、网关、回归测试及 `docs/product/standalone-web.md`：消费所有 Harness 共用的 session-import 契约，无 Codex 专属 Host 或 Renderer 分支。
- `packages/web-server/src/ch-sessions.ts`、权限选择器及对应网关/浏览器回归：草稿固定展示与提交共用的权限选择；有效权限缺失时清除旧投影并显示“原生配置”。这些行为适用于全部 Harness，无公共契约扩展。

## 验证记录

| 层次 | 命令或方式 | 结果 |
|---|---|---|
| Adapter 公共行为 / 原生边界 | 定向 `test/process.test.ts`、`test/authentication-native.test.ts`，隔离 app-server 夹具 | 分别 16／6 项通过；包括同页与跨页归并、权威元数据、提交复查、身份校验及关闭取消；相邻认证测试并行运行曾出现进程日志启动时序失败，单独重跑通过 |
| 插件加载 | 将构建的 codex-cli 插件复制到隔离临时根，通过真实 Loader 冷加载 | 通过，关闭后清理全部临时文件 |
| Host 集成 | 定向 `host-runtime/test/codex-cli-harness.test.ts`、`harness-session-import.test.ts` | 9 项通过；包含归并后映射导入、完整夹具历史与续写同一身份，不改 Host 生产实现 |
| 真实原生验收 | macOS、CLI `0.161.0`，本机只读发现与原生 thread/read，临时 Mapping Store | 231 条文件级原生记录归并为 226 个有效候选；公共列表、元数据复查与幂等映射导入通过；生产映射不变，无真实 resume／续写或 Model 请求 |
| Fast Adapter / 原生边界 | 定向 `test/fast-mode.test.ts` | 10 项通过；含无元数据的旧 CLI、创建、开关、活动 Turn、拒绝、恢复、过期与缺失确认；只使用隔离夹具 |
| Fast Host / Web | 定向 `host-runtime/test/codex-cli-harness.test.ts` 与 Web `model-selection.test.ts` 的 Fast 用例 | Host 4 项、Web 390px / 1280px 两项通过；公共目录、配置路由与通用闪电控件，不代表真实 Codex Web 端到端推理 |
| Fast 构建与加载 | `npm run typecheck`、`npm run build:typescript`；将构建后的 Codex 插件复制到隔离根，经真实 Loader 冷加载 | 通过；隔离原生夹具验证目录 Fast 引用、Fast 创建与关闭；定向 ESLint 和格式检查覆盖改动文件 |
| Fast 原生配置 | CLI `0.161.0`，通过 `CodexModelSelection` 连接本机 app-server；ephemeral Thread，无 Prompt | 原生目录、开启 `priority`、关闭后确认 `default` 通过；进程关闭，临时工作目录清理，无真实 Model 请求 |
| 中断与故障恢复 | 定向 `test/authentication-native.test.ts`、`test/fast-mode.test.ts`、Host `app-server-host.output-failure.test.ts`、`client-channel-recovery.test.ts`、`external-thread-recovery.test.ts` | 31 项通过；隔离夹具覆盖缺失 Item 终态、保留部分内容、后续 Turn，以及异常关闭后配置操作恢复同一原生身份；不代表真实 Model 请求验收 |
| 权限投影与草稿 | Adapter `process.test.ts`、`fast-mode.test.ts`、`authentication-native.test.ts`；Host `codex-cli-harness.test.ts`；Web 权限、偏好、路由、会话、实时状态和导入定向回归 | Adapter 44 项、Host 4 项、Web 网关 28 项通过；认证测试首次并行执行有进程日志时序失败，单独重跑 8 项通过；无真实 Model 请求 |
| 权限浏览器与插件 | Web `browser/permissions.test.ts`；隔离 Bundle 经真实 Loader 冷加载并连接假原生进程 | 390px / 1280px 两项通过；未知权限展示、主动选择及原生权限回填通过，关闭后清理隔离目录 |
| 权限静态检查 | `npm run typecheck`、`npm run build:web:ui`、定向 ESLint / Prettier、源码边界与 `git diff --check` | 类型、Web 构建、格式和修改模块的源码边界通过；ESLint 未覆盖 Web UI（无匹配配置），全仓库边界检查被已有 `dist/codexhost-web/node_modules/tslib` 声明文件阻塞 |
| 委派环境传递 | 定向 `test/command.test.ts`、`test/delegation-environment.test.ts`、`test/process.test.ts` | 32 项通过；隔离原生进程夹具及其子进程验证连接参数、CLI/Node 路径、创建与恢复身份、令牌更新、会话间隔离及默认环境不被修改；不代表真实 Model 驱动的委派验收 |
| 原生会话占用 | Adapter `process.test.ts`、Protocol `thread-fork.test.ts`、Host `codex-cli-harness.test.ts` / `client-channel.test.ts`；Web `ch-host-client.test.ts` / `ch-client-gateway.test.ts` | Vitest 67 项、Web 5 项通过；隔离协议夹具验证 writer 冲突分类、导入后的快照错误码、同身份重试、Web 错误透传与过期快照重同步；TypeScript 构建和类型检查通过，无生产会话恢复或 Model 请求 |
| 占用会话条件导入 | Adapter `test/import-session.test.ts`、`test/process.test.ts` | 16 项导入回归与 30 项既有进程回归通过；验证同 ID 恢复、两种 writer 冲突、完成轮分页、精确前缀、新 ID 续写、已知 ID 保留及未知结果不重试；1500ms RPC 超时夹具通过，无真实 Model 请求 |
| 导入持久化与退出 | Host `prepared-session-import.test.ts`、`codex-cli-harness.test.ts`、`harness-session-import.test.ts`、`client-channel.test.ts`；Mapping Store 定向测试 | Host 准备导入 10 项、集成与通道 33 项、存储 60 项通过；涵盖来源与新 ID 去重、重启恢复、未知结果保留、提交失败及准备／快照阶段退出清理 |
| 分支来源与加载 | Web 会话／历史投影测试、390px／1280px 浏览器测试、隔离插件冷加载 | Web 24 项、浏览器 2 项通过；真实 Loader 加载 Bundle 后验证 writer 冲突、完成轮 Fork 和历史读取，所有夹具进程关闭；TypeScript / Web 构建、类型、Lint、修改文件格式检查通过 |
| 原生占用时 Fork | macOS CLI `0.161.0`，临时 CODEX_HOME 和两个独立 app-server | 源会话持有 writer 时 resume 被拒绝、带 completed `lastTurnId` 的 Fork 成功，副本截止于所选回合且源会话仍加载；未发送真实 Model 请求，临时目录已清理 |
| 委派最高权限 | Adapter `test/process.test.ts`、包级构建、定向 ESLint / Prettier | 34 项通过；隔离夹具覆盖 Auto / 只读默认下的无人值守最高权限、冲突拒绝与原生确认失败；普通默认行为保持不变，无真实 Model 请求 |
| Desktop / 真实委派 | 不改变 Desktop 原生路径 | 未执行 |
