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
| A9 | 错误与并发 | 必做 | P0 | 受限 | src/session.ts、src/rpc.ts | test/authentication-native.test.ts | 无原生 steering |
| A10 | 关闭 | 必做 | P0 | 支持 | src/plugin.ts、src/session.ts、src/rpc.ts | test/process.test.ts | 关闭进程与用量读取 |
| B1 | 切换 Model | 原生有则必做 | P1 | 支持 | src/session.ts | test/process.test.ts；configuration 声明 | 原生参数 |
| B1-Fast | 原生 Fast 服务档位 | 原生有则必做 | P1 | 支持 | src/model-selection.ts、src/plugin.ts、src/session.ts | test/fast-mode.test.ts；CLI 0.161.0 原生目录与 ephemeral Thread 开关确认 | 仅原生 serviceTiers 声明 priority 时提供 fastModel；创建、恢复与 Turn 传原生 model/serviceTier；切换等待 settings 通知 |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 支持 | src/session.ts | test/process.test.ts；configuration 声明 | 原生 effort |
| B3 | 权限模式 | 原生有则必做 | P1 | 支持 | src/session.ts、src/permission-modes.ts | test/process.test.ts | live；创建与恢复从原生审批策略和沙箱响应确认权限；自定义或缺失配置不冒充标准档位 |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 受限 | src/plugin.ts、src/session.ts | test/process.test.ts | 仅按所选权限模式传参，未单独验证执行策略 |
| B5 | Fork | 原生有则必做 | P1 | 不支持 | src/plugin.ts、src/session.ts | history.fork=false；open 拒绝 | 原生精确边界尚未接入 |
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
| B16 | 向下委派 | 原生有则必做 | P2 | 待验证 | src/command.ts | — | 未做真实原生发现与调用验收 |
| C1 | 展示元数据 | 必做 | P1 | 支持 | manifest.json、assets/icon.png | host-runtime/test/installed-harness-plugins.test.ts | Web 展示身份 |
| C2 | 手动安装指引 | 必做 | P1 | 受限 | manifest.json | links.installation | 官方文档链接，无内嵌安装步骤 |
| C3 | 版本检查与更新 | 必做 | P1 | 受限 | src/plugin.ts | 无 installation 方法 | 需用户在原生 CLI 管理 |
| C4 | 首次安装 | 可选 | P2 | 不支持 | src/plugin.ts | 无 install 方法 | 使用原生安装方式 |
| C5 | 自定义启动路径 | 条件必做 | P1 | 支持 | manifest.json、src/command.ts | test/command.test.ts | 拒绝 Desktop proxy/shim |
| C6 | 会话导入 | 可选 | P2 | 支持 | src/plugin.ts、src/codex-session-import.ts、src/session.ts | test/process.test.ts；host-runtime/test/codex-cli-harness.test.ts；本机只读发现与临时映射 | 按逻辑 Session ID 归并；重复项由原生 thread/read 确认；导入前重新确认身份与元数据；原生 resume 与快照校验 ID |
| C7 | 全局用量统计 | 可选 | P2 | 不适用 | — | 独立 codex-usage 插件 | 不由执行插件重复拥有 |
| C8 | 账号额度 | 可选 | P2 | 支持 | src/account-usage.ts、src/plugin.ts | test/account-usage.test.ts | 原生 rateLimits |
| D1 | Workspace / 构建 | 预装时必做 | P1 | 支持 | package.json、tsconfig.json | 根 tsconfig.json | 既有 Workspace |
| D2 | 预装清单 | 预装时必做 | P1 | 支持 | manifest.json | scripts/release/harness-plugins.json | 仅 Web |
| D3 | 加载测试 | 预装时必做 | P1 | 支持 | src/plugin.ts | host-runtime/test/installed-harness-plugins.test.ts | 不代表真实原生验收 |
| D4 | 文档 | 预装时必做 | P1 | 支持 | CAPABILITIES.md | docs/product/standalone-web.md | Codex CLI 与导入约束 |
| D5 | 其他 | 可选 | P2 | 不适用 | — | — | 不改变 Desktop 官方路径 |

## 受限与已知缺口

- A9：原生 steering 明确拒绝；Host 使用所有外部 Harness 的队列规则。
- B3：原生依据为 CLI `0.161.0` 生成的 `ThreadStartResponse` / `ThreadResumeResponse`：响应含 `approvalPolicy` 与 `sandbox`。仅匹配目录内的审批策略和沙箱类型；粒度化审批、外部沙箱及缺失字段不报告标准权限 ID。读取有效权限不等于选择权限，未显式选择时不追加 Turn 权限覆盖。既有 live 切换仍用于后续 Turn，未单独验证活动 Turn 内权限变化。
- B4、B15、B16：未完成完整无人值守与双向委派验收，不声称完整委派支持。
- B11、B12：委派 Item 和自主 Turn 事件投影不等于完整子代理历史与自主能力交付。
- B1-Fast：没有 `serviceTiers` 元数据的旧 CLI 不提供 Fast，不从旧速度标签推导档位。普通选择显式清除 Fast；无配置提示的恢复保留原生档位。切换仅保证后续 Turn 使用确认的配置，未实测真实推理速度、计费或生产 Session 的 Fast 恢复；恢复由隔离协议夹具验证。原生设置确认超时或失效会关闭 Session，避免未知档位继续发送。
- B14：请求级计量尚未独立验收。
- C2、C3：提供官方安装链接与可自定义启动路径，没有插件内安装更新工作流。
- C6：Codex 的分页历史可将同一逻辑 Session 保存为多个原生 rollout 段；Adapter 不能把文件级列表直接当作唯一会话列表。归并使用逻辑 Session ID，重复项与提交时的元数据以原生 thread/read 为准，不按文件时间猜测权威段，不复制或改写原生历史。无法确认其他进程的运行状态；真实 CLI 的映射导入、resume 和续写仍需实机验收。

## 插件外改动

- `tests/fixtures/codex-auth-peer.cjs`：隔离夹具提供原生 cursor 分页、权威元数据读取、分段逻辑历史、身份不一致与原生读取失败响应；支持服务档位目录、设置通知、设置拒绝、跨进程档位恢复及 Turn 中间通知；权限响应覆盖原生默认、自定义、缺失及显式选择不匹配。
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
| Desktop / 委派 | 不改变 Desktop 原生路径 | 此次未执行 |
