# GitHub Copilot 能力清单

## 基本信息

| 项 | 内容 |
|---|---|
| Harness ID | `copilot`（独立预装插件） |
| 原生接口与传输方式 | 首选官方 `@github/copilot-sdk`，显式连接用户安装的 Copilot CLI，通过 headless stdio JSON-RPC 通信；不使用 ACP |
| 已验证的原生版本 | SDK `1.0.25` + CLI `1.0.102`，macOS arm64 / Node 24.18.0 / local / gh-cli；其他平台与认证来源未实测 |
| 交付范围 | 仓库内预装、原生会话后端及接收委派已有实现；Desktop 验收和剩余 P0/P1 矩阵仍在进行。向下委派属于 P2 |
| 参考插件 | Claude Code：SDK 生命周期和双向交互；Qoder：SDK 插件工厂、Catalog 和安装管理；Pi：稳定历史、Rollback 与用量；OMP：恢复配置和自主 Turn。只参考对应职责 |
| 最后验证 | 2026-10-22；执行真实 SDK/CLI 请求、隔离 Loader/Bundle、聚焦测试；只读取脱敏认证状态，不读取凭据 |

此清单区分已实现、原生实测和仍未覆盖的验收。受限项不构成完整 P0/P1 交付声明；详细原生记录见 [NATIVE-VERIFICATION.md](test/NATIVE-VERIFICATION.md)。

## 能力

证据列中的 S1–S8 是下文的静态依据，不是原生实测或测试通过记录。

| # | 功能 | 必做 | 优先级 | 结论 | 实现位置 | 证据 | 备注 |
|---|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | 支持 | manifest.json | installed-harness-plugins.test.ts；host-bundle.test.mjs | 公共 Manifest schema；能力由 inspect 提供 |
| A2 | 工厂 | 必做 | P0 | 支持 | src/plugin.ts | 真实 Loader 独立实例测试 | 工厂复制环境；SDK 只在插件 Bundle 中 |
| A3 | 检查 | 必做 | P0 | 受限 | src/adapter.ts、src/client.ts | test/adapter.test.ts；scripts/probe.mjs；原生记录 G1 | 同 cwd 检查合并，成功结果保留至 refresh 或 close；refresh 跳过完成缓存并共享进行中检查，外部认证/配置变化后需刷新；失败可重试，close 停止并排空；inspect 不创建会话，BYOK 尚未实测 |
| A4 | 创建 Session | 必做 | P0 | 支持 | src/session.ts | test/session.test.ts；原生记录 G2 | 默认惰性创建；配置或无人值守先真实确认；只清理未提交草稿 |
| A5 | 执行 Turn | 必做 | P0 | 支持 | src/session.ts、src/projection.ts | test/session.test.ts、projection.test.ts；真实 Host 接收委派测试 | 先确认逻辑消息身份再接受 Turn；早到事件有界缓冲，包含完整原生工具循环；turn.steer 明确 unsupported，不接收输入，交由公共 Host 停止后新开一轮 |
| A6 | 取消 | 必做 | P0 | 支持 | src/session.ts、src/interactions.ts | 原生记录 G4；session.test.ts 合成取消竞态；app-server-host.copilot.real.test.ts | 等待 session.idle.aborted；取消 RPC 成功/失败/超时绑定执行实例，交互按 Turn 清理；旧回调不影响用户或自主新轮 |
| A7 | 只读快照 | 必做 | P0 | 支持 | src/history.ts、src/projection.ts | test/history.test.ts、projection.test.ts；原生 compaction/分页记录 | 稳定消息/Item 身份；历史缺少持久终态时 unknown；expired 有界重读，不返回部分历史 |
| A8 | 持久身份 + resume | 必做 | P0 | 支持 | src/refs.ts、src/session.ts | test/resume.test.ts、resume.native.test.ts、projection.test.ts；原生 cold resume/环境覆盖记录 | 原生严格 resume，无重复全量预读；缺失/损坏日志不替换为空会话；完整快照与 Fork 分页保留 |
| A9 | 错误与并发 | 必做 | P0 | 支持 | src/errors.ts、src/session.ts | test/errors.test.ts、adapter.test.ts、session.test.ts；真实 Host busy 记录 | 类型化错误、操作阶段及脱敏诊断；不转发 stderr/认证头/secret 答案；故障终态、并发拒绝与迟到隔离保留 |
| A10 | 关闭 | 必做 | P0 | 支持 | src/session.ts | 关闭重试/待答交互/断连合成测试；真实 stopErrors=0 | 55 秒清理预算；已尝试提交输入的会话保留历史，失败关闭可重试 |
| B1 | 切换 Model | 原生有则必做 | P1 | 受限 | src/configuration.ts、src/session.ts | 原生 G2/G6；配置确认负向测试 | 使用原生刷新目录；当前 Free 账号只提供 Auto，具体模型选择先校验资格；不填入内置具体模型表 |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 受限 | src/configuration.ts、src/session.ts | 原生 Auto+high 创建拒绝；configuration.test.ts、configuration.native.test.ts、session.test.ts | 专用 setReasoningEffort RPC，先校验模型公布的选项再读回；Auto 原生不支持 Thinking，付费账号的可选 effort 矩阵未实测 |
| B3 | 权限模式 | 原生有则必做 | P1 | 受限 | src/adapter.ts、src/session.ts | 原生 G6 | manual/allow-all 成功读回；assisted 返回 success=false 时保持旧状态 |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 支持 | src/session.ts、src/refs.ts | 真实 allow-all/托管 sandbox 检查；公共 Host 原生测试 | 原生全权限基线，不自动批准或代答；保留问题和人工接管；创建时冲突拒绝 |
| B5 | Fork | 原生有则必做 | P1 | 受限 | src/adapter.ts、src/history.ts | 原生 G5 | 排他边界、副本前缀、源忙拒绝和失败副本清理已验证；Auto 配置继承通过；支持 Thinking 的其他账号矩阵未实测 |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 待验证 | 未实现 | S4：sessions.fork；S5：resume workingDirectory | setter 存在不证明重绑定成功；验证实际工具 cwd、配置和资源归属 |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | 受限 | src/adapter.ts | 原生 G5 空前缀副本续写；app-server-host.copilot.real.test.ts | 精确去掉最后根 Turn，不修改源和项目文件；公共 Host 换绑、续跑和重建通过，Auto 配置保持通过；其他账号 Thinking 与真实 UI 待验收 |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | 支持 | src/projection.ts、src/file-changes.ts、src/session.ts | 真实工具/文件 fixtures；session/projection 合成归属回归；native.test.ts 失败工具后同轮继续 | Diff 需匹配已开始的工具；实时退休事件不串轮，历史后到结果归回原工具所属轮；异步 shell 启动按工具调用显示 |
| B9 | 审批 | 原生有则必做 | P0 | 支持 | src/interactions.ts | test/interactions.test.ts；原生审批取消/续跑 | 仅单次允许/拒绝，不升级授权范围 |
| B10 | 提问 | 原生有则必做 | P0 | 受限 | src/interactions.ts、src/elicitation.ts | legacy ask_user 原生人接管；primitive form 原生往返及校验测试 | 单选/自由文本/多选/布尔/数字和受支持约束；URL 流与额外约束明确 unsupported |
| B11 | 原生 Subagent | 原生有则必做 | P2 | 待验证 | 未实现 | S3：agentId、subagent.started/completed/failed | observe 和 readTranscript 分别验证；不能把子 Agent 的 user.message 混进根用户 Turn |
| B12 | 自主 Turn | 原生有则必做 | P1 | 受限 | src/session.ts、src/background.ts | autonomous.native.test.ts；原生 async shell；background.test.ts | 支持有稳定根消息的自主 Turn 和后台租约；Autopilot/Plan 模式拒绝 |
| B13 | 会话用量 | 原生有则必做 | P1 | 支持 | src/usage.ts、src/session.ts | 原生 token/Credits/计时；usage.test.ts、usage-telemetry.test.ts、usage.native.test.ts、app-server-host.copilot.real.test.ts | 累计快照替换；可靠 nano-AIU / 1e9 映射为 AI Credits，partial/unavailable 不显示完整花费；不混用 premium request cost 和 USD；生成/API 速度、最近及累计缓存命中事实 |
| B14 | 请求级计量 | 原生有则必做 | P2 | 待验证 | 未实现 | S3：assistant.usage；S4：持久历史读取 | 验证稳定请求 ID、实际模型、历史是否保存 usage；不能把用户回合汇总当单次模型请求 |
| B15 | 接收委派 | 必做（验证项） | P1 | 受限 | 公共 Host Coordinator；src/adapter.ts | app-server-host.copilot.real.test.ts（真实 CLI） | 首轮/续轮/busy/read/wait/cancel、提问协议、活期权限切换和 Host 重建续跑通过；真实 Desktop 与远程尚未验收 |
| B16 | 向下委派 | 原生有则必做 | P2 | 待验证 | 未实现 | S5：追加 systemMessage、skillDirectories；委派规范 | 优先验证已安装 Host Skill 可见性；否则评估会话级追加说明，只含环境变量名；必须真实执行链路验收 |
| C1 | 展示元数据 | 必做 | P1 | 受限 | manifest.json、assets/icon.png | 真实 Loader 解析图标 | SDK v1.0.25 MIT 图标；浅色/深色真实 UI 尚未验收 |
| C2 | 手动安装指引 | 必做 | P1 | 支持 | manifest.json | 官方 CLI 文档；Manifest schema 检查 | 展示 npm 安装、原生登录、显式路径指引；不自动安装 |
| C3 | 版本检查与更新 | 必做 | P1 | 支持 | src/installation.ts | 真实安装 check：1.0.102；test/installation.test.ts | 只更新所选 npm prefix、合并并发更新；实际 CLI 无可用更新，未升级它 |
| C4 | 首次安装 | 可选 | P2 | 待验证 | 未实现 | S8、当前 createHarnessInstaller | 官方安装来源与非交互行为尚未验证；不能因未登录而重装 |
| C5 | 自定义启动路径 | 条件必做 | P1 | 不适用 | — | S8：目标为独立 Copilot CLI；当前连接页规范 | 本方案不依赖桌面应用内置 CLI；显式命令覆盖走公共 discovery 的 CODEXHOST_COPILOT_COMMAND，不套用应用目录设置 |
| C6 | 会话导入 | 可选 | P2 | 待验证 | 未实现 | S1：listSessions；S4：持久事件只读读取 | 只读 resolve 后返回完整 nativeRef；列表可见不代表一定可恢复，运行状态未知用 null |
| C7 | 全局用量统计 | 可选 | P2 | 待验证 | 未实现 | S3：用量事件；原生存储格式尚未验证 | 必须直接只读本地存储，不为全局统计启动 SDK/CLI；验证跨 Fork 的去重身份 |
| C8 | 账号额度 | 可选 | P2 | 支持 | src/account.ts、src/account-usage.ts | 原生 quota.refresh/providerQuotas；account.test.ts、account.native.test.ts；公共 Host 账号接口 | 新鲜查询与 15 秒浮窗缓存；明确 AI Credits/requests 单位，不把会话花费当余额；查询草稿清理，无模型 Turn |
| D1 | Workspace / 构建 | 预装时必做 | P1 | 支持 | package.json、tsconfig.json；根 tsconfig.json、package-lock.json | npm run build:typescript；npm run typecheck | 固定 SDK 1.0.25；原生 CLI 独立安装 |
| D2 | 预装清单 | 预装时必做 | P1 | 支持 | scripts/release/harness-plugins.json、prepare-payload.mjs | 实际 macOS arm64 payload + Node 24.13.1 仓库外加载；发行测试 | 依赖和许可证随 payload；未制作/发布其他平台安装包 |
| D3 | 加载测试 | 预装时必做 | P1 | 支持 | packages/host-runtime/test/installed-harness-plugins.test.ts | 真实 Loader、仓库外搬移 Bundle 测试 | 无 workspace 依赖；显式缺失 CLI 返回 notInstalled |
| D4 | 文档 | 预装时必做 | P1 | 支持 | docs/harnesses/copilot/copilot-harness-integration.md；docs/index.md；README | 能力清单、原生记录、设计和任务同步 | 区分后端/协议验证与真实 UI；未完成项保持未勾选 |
| D5 | 其他 | 可选 | P2 | 不适用 | — | 当前 Desktop 目录驱动机制 | 不预先修改排序或诊断 ID 名单；真实 Desktop 验收仍属于交付要求 |

## 原生依据

- S1：[SDK v1.0.25 Client](https://github.com/github/copilot-sdk/blob/v1.0.25/nodejs/src/client.ts)：原生查询、创建/恢复、进程启动与释放。
- S2：[SDK v1.0.25 Session](https://github.com/github/copilot-sdk/blob/v1.0.25/nodejs/src/session.ts)：send、原生事件等待、abort、getEvents、disconnect、模型设置。
- S3：[SDK v1.0.25 Session events](https://github.com/github/copilot-sdk/blob/v1.0.25/nodejs/src/generated/session-events.ts)：持久/临时标记、逻辑 messageId、agentic loop turnId、工具、交互、子 Agent 和 Usage。
- S4：[SDK v1.0.25 生成的原生 RPC](https://github.com/github/copilot-sdk/blob/v1.0.25/nodejs/src/generated/rpc.ts)：带类型的只读历史、配置、Fork 与回退。生成接口中的实验性声明不代表所有用户安装版本都实现了对应方法。
- S5：[SDK v1.0.25 Types](https://github.com/github/copilot-sdk/blob/v1.0.25/nodejs/src/types.ts)：RuntimeConnection.forStdio、copilot-cli 默认行为、认证、ModelInfo、Session 配置、权限和提问回调。
- S6：[SDK v1.0.25 能力比较](https://github.com/github/copilot-sdk/blob/v1.0.25/docs/troubleshooting/compatibility.md)：程序化入口与 TUI 功能的区别。
- S7：[SDK v1.0.25 发布](https://github.com/github/copilot-sdk/releases/tag/v1.0.25)及[版本配对元数据](https://github.com/github/copilot-sdk/blob/v1.0.25/nodejs/package.json)：SDK 发布基线；本机兼容证据单列在原生验证记录。
- S8：[官方 CLI 安装](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli)、[认证](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)：发行和登录依据；具体渠道、平台尚待核实。
- S9：[SDK v1.0.25 认证](https://github.com/github/copilot-sdk/blob/v1.0.25/docs/auth/authenticate.md#github-signed-in-user)：明确支持复用 Copilot CLI 登录后保存在系统凭据库中的 OAuth；其认证优先级还包括显式 Token、环境变量和 gh auth。S1 的启动逻辑仅在 useLoggedInUser 为 false 时追加 --no-auto-login，S5 明确 true 时尝试存储的 OAuth 或 gh auth。这是接口与源码依据；本机 gh-cli 复用已另行实测，Copilot 自身 OAuth 存储来源尚未验证。

## 实现与持久化

- 创建和恢复共用 `enableConfigDiscovery: true`，启用原生全局及项目配置发现，包括 skills 和 custom agents；本次开关修正按用户要求未运行测试。
- `command.ts` 使用公共 discovery；Windows 标准 npm shim 解析到同一安装的实际 JS/可执行入口，校验 package 身份/bin 和 shim 引用，不执行 shell 或回退到其他 CLI。Windows 布局 fixture 与 SDK 含空格 JS 调用通过；Windows 实机仍未验证。
- 每个可写 Session 独立拥有 SDK Client；工厂环境加 Session 覆盖，undefined 表示删除。不改变 HOME、COPILOT_HOME 或 Keychain 配置。
- 普通 create 惰性初始化。草稿 select 需真实创建、设置和读回；本实例未提交根消息的草稿关闭时原生删除。已提交会话 close 永远保留历史。
- NativeSessionRef locator 为 `{storage:"copilot-cli",version:1}`，无人值守创建增加 `executionPolicy:"unattended-full-access"`，恢复保留其 sandbox 启动配置，权限以原生当前状态为准；用户可实时切换权限。逻辑 Turn key 使用持久根 messageId，Checkpoint 解析为下一根用户事件的排他边界。
- turn.start 仅在根消息身份确认后报告接受。无身份的原生拒绝不发布成功终态；不能将随后 abort 误归给上一轮。历史终态不从最终助手文本推断。

## 受限与已知缺口

1. 原生认证来源实测为 gh-cli，用户未额外登录即可使用。尚未验证 Copilot OAuth 存储登录、有效环境 Token 优先级及完全未登录环境；不会为覆盖这些用例导出 Token 或隔离原生配置。
2. 当前 CLI 的 /model 明示 Copilot Free 仅支持 Auto。原生 RPC 的具体模型数组为空且省略虚拟 Auto；Adapter 按已认证 Copilot/会话 Copilot provider 提供原生 Auto 路由，不补造具体模型或 effort。此前 gpt-6-luna/high 在执行时被原生纠正为 auto，不能当成受支持的配置。模型和 Thinking 选择现先校验资格；Auto 的 Thinking 被明确拒绝。付费账号多模型/Thinking 矩阵及真实 Desktop UI 未实测。
3. primitive elicitation、压缩历史、连接断开/关闭重试和稳定根消息的自主输入已有证据。浏览器 URL elicitation 尚未验证完整往返并明确拒绝；Autopilot/Plan 模式未接入。复杂后台 Subagent Transcript 属于 P2。
4. Adapter 提供明确初始 Model：Auto 优先，否则目录首个可用项；用户已有选择仍优先。公共 Renderer 保持原实现，不展示额外 Default 状态。完整 Desktop 工具/交互/恢复 UI 矩阵尚未验收。
5. 跨目录 Fork、完整原生 Subagent Transcript、请求级计量、向下委派、一键安装、历史导入、全局统计按提案属于 P2；账号额度与会话 Credits 已按用户追加要求接入；不提供空实现。
6. SDK 的 URL elicitation 携带 url 和浏览器往返语义；当前 HostQuestion 只表达文字/选项响应，没有打开浏览器与原生完成回调的关联。若扩大这部分范围，应设计 Harness 无关的可选 external-action Interaction，并同时更新公共 schema、Host 和 Renderer；本次不把它伪装成普通文字回答，也不增加 Copilot 专用分支。目标 CLI 的 URL 往返仍需实测，不能仅凭类型宣布支持。

## 插件外改动

- 根构建引用、lockfile、预装清单及发行许可证资源。
- 已安装插件集合测试、真实 Copilot/公共 Coordinator 集成测试、发行 payload 断言。
- 搬移 Bundle 测试将继承的 CODEX_HOME 指向其既有的合成官方进程 fixture，防止本机 CODEX_HOME 干扰测试；不影响真实 Copilot 认证或配置。
- 已撤回为未知默认 Model 增加的公共 Renderer 改动；Host、Renderer、protocol-core、shared-contracts 和 Rust 生产代码均无改动。浏览器测试覆盖插件目录的初始选择与真实 CLI 发送。

## 验证记录

详见 [原生验证记录](test/NATIVE-VERIFICATION.md)，其中区分原始现象、原因排查、合成测试与原生验收。

- 最新综合回归：21 个文件通过，95 项通过、2 项跳过。其中 5 项为真实 CLI 用例（配置资格、多轮/工具失败、精确派生、原生自主输入、公共 Host 接收与恢复）；跳过的 2 项是 Windows npm 启动和未配置的 OpenCode 原生检查。
- `npm run typecheck`、`npm run lint`（含边界检查）、改动文件 Prettier、`git diff --check`：通过。
- `npm run build:typescript`、最新源码 macOS arm64 payload 的 TypeScript/Renderer/Rust release 构建与文件/许可证校验：通过。
- 隔离 Loader/搬移 Bundle/Host 核心隔离测试：通过。最新 payload 插件搬到仓库外，使用随包 Node 24.13.1 和本机显式 CLI，inspect 返回 ready、Auto，退出码 0；不借用 workspace node_modules。
- 只读 probe：SDK 1.0.25、CLI 1.0.102、协议 3、gh-cli；Adapter modelCount=1、modelIds=[auto]、sessionsUnchanged=true、stopErrorCount=0。原生具体模型数组仍为 0，原因是本机 Auto-only 账号资格。
- 非法初始 Model/Thinking 拒绝后无草稿残留；有效 Auto 多轮、冷恢复、Fork 和 Rollback 保持配置。原生 Auto 明确不支持 effort，不将其错误归因为 SDK 状态丢失。
- OpenSpec 严格验证通过；任务为 9/13，其他账号多模型/Thinking、认证矩阵、真实 Desktop/远程与跨平台覆盖仍有未完成项。
- 没有额外登录、启动其他 Agent、运行 npm start、推送、合并或发布。


- 初始选择最终验收：77 项聚焦回归通过、5 跳过；8 项配置/原生相关检查及 1 项浏览器→真实 CLI 的 Auto 预选发送通过。公共 Renderer 源码和测试均恢复到原版本，默认策略只属于 Copilot Adapter；生效需重新加载 Host。

- 账号额度与会话 Credits：原生 quota.refresh 返回 authoritative_budget/account_snapshot，带 ai_credits 单位；设置页使用 inspectAccount，新鲜查询前清除缓存，前后认证不一致则丢弃。credits()/refreshCredits() 提供最多 15 秒缓存；临时查询草稿不发送消息，查询后删除，删除失败在 close 重试。会话 totalNanoAiu 按官方单位 /1e9，部分或不可用金额保持未知，不换算 USD。
- 账号/Credits 最终验证：120 项聚焦回归通过、7 项条件跳过；2 项定向原生 SDK/公共 Host 验收通过。当前版本 SDK 1.0.25、CLI 1.0.102；quota-only 草稿已验证删除，会话 Credits 与原生累计值一致。
- P1 审查竞态修复：新增永久失败复现后修复；session/history/projection/interactions/derivation 等 8 文件 57 项聚焦测试及类型、lint/边界、格式检查通过。取消按执行实例隔离，工具按调用起始归属；本轮没有新增原生验收。
- 本次额度接入已通过格式、OpenSpec 严格校验及最新 macOS payload 构建/文件校验；没有遗留以账号测试临时目录为 cwd 的 Copilot 进程。
- 速度与缓存补充验收：123 项聚焦检查、12 项浏览器检查及 1 项真实 CLI 速度/刷新/冷恢复验收通过；原生计时字段存在且已验证，缺失时不估算。
- 速度展示沿用公共 Host/Renderer 字段；类型、lint/边界、格式、OpenSpec 与最新 macOS payload 校验通过，没有新增 Copilot 专用 UI 分支。
- 补充真实 Host 用量链路验收：隔离 Loader 加载 Copilot 插件，真实模型请求完成后，公共 codexhost/thread/usage/inspect 返回生成/API 速度、最近/累计缓存命中率及 TTFT；私有 sessionCacheUsage 已转换并剥离。定向原生检查 1 通过，2 个无关用例按名称过滤跳过。
- 局部审查修正：诊断分型/脱敏与阶段、同 cwd inspect 合并及清理、严格 resume 取消重复预读、Windows npm 同安装入口解析、完成状态单一事实已完成。插件/Loader 聚焦测试 143 通过、9 跳过；真实 CLI 无模型恢复夹具 2 通过；类型、lint/边界、格式检查通过。Windows 启动仍仅 fixture 覆盖，未声称实机验收；额度与 AI Credits 保留。
