# Kimi Code 与 MiMo Code 的 Harness 接入方案

状态：首版实现已通过 Windows 本地工程验收，包含两个原生 Adapter、Desktop 接线和预装发行；真实 CLI 配合受控 localhost Provider 的工具、交互、取消与恢复均已验收，真实在线 Provider/Model 与本机 Desktop 的端到端验收尚未完成。结果、限制及环境受阻项见[实现文档](../harnesses/kimi-mimo-integration.md)。下文“已完成的准备”“续检结果”保留规划阶段的证据，不代表新增实现的验收结果。

核对日期：2026-09-22。codexhost 基线：`fb36f2dfee08cb8db68d3eee362f02a7ca61d3ae`。

## 目标与交付范围

在 codexhost 中提供可选择的 **Kimi Code** 和 **MiMo Code** 两个独立 Agent，分别运行各自的原生 Harness。拟采用插件 ID `kimi-code`、`mimo-code`；这是本方案的新命名，尚未写入运行配置。

交付包含插件后端、Desktop 产品接入和预装发行。基本完成标准是：用户选择 Agent 后创建任务，执行工具与多轮对话，处理中断和人工交互，重启 Host 后恢复同一原生会话继续工作。首先在当前 Windows 环境验收；其他平台、SSH 和 Remote Control 分别记录验证结果。

两个 Harness 保留各自的认证、原生会话、模型目录和权限语义。仅在已有 Pi 或 OpenCode 中配置 Kimi/MiMo 模型，可以作为使用模型的另一条路径，但不能代替上述独立 Harness 接入。

## 已完成的准备

| 项目 | 本次观察与操作 |
| --- | --- |
| 远端 | `origin` 已绑定 `unununnnn/codex-host-wk`，无需新建仓库。GitHub 返回该仓库是 `BytePioneer-AI/codex-host` 的 fork，当前访问权限为 ADMIN。 |
| 源码 | 初始目录没有提交或检出的源码；已 fetch 远端 main，并建立本地 main 跟踪 origin/main。 |
| 工作分支 | 已创建 `codex/kimi-mimo-integration-plan`。本次不提交、不推送。 |
| 原有文件 | 原 AGENTS.md 已保存至 `.git/codex-preserved/20260922-192543/AGENTS.md`，SHA-256 校验一致；原 `docs/agents/` 文件保留。 |
| Kimi Code | 本机 `kimi --version` 返回 `2.0.2`；可执行文件位于 `C:/Users/PC/.kimi-code/bin/kimi.exe`。已读取 `kimi web --help`。 |
| MiMo Code | 本机 `mimo --version` 返回 `0.1.14`；可执行文件位于 `C:/Users/PC/.mimocode/bin/mimo.exe`。已读取 `mimo serve --help`。 |
| 开发环境 | Node.js `v24.14.0`；存在 package-lock.json，尚未安装本仓库 node_modules。 |

上表记录仓库准备阶段的结果。后续在独立临时目录中启动了两套原生服务，并完成下述协议探测；没有读取用户模型凭据、改变用户登录状态或提交模型任务。

## 续检结果与证据边界

续检日期同为 2026-09-22，沿用上述分支和源码基线。Kimi 使用独立 `KIMI_CODE_HOME`，MiMo 使用独立 `MIMOCODE_HOME`；原生进程仅继承运行所需的系统环境，MiMo 探测使用 pure 模式。两套服务均绑定 `127.0.0.1`，保持本地服务鉴权，使用临时目录内新建的测试会话。[K5][M3]

| 检查 | 实际结果 | 能证明的范围 |
| --- | --- | --- |
| MiMo SDK 发布包 | `npm view`、`npm pack --ignore-scripts` 确认 `@mimo-ai/sdk@0.1.14` 已发布，并读取实际 `dist` 文件。 | 发布包存在；不只依赖默认分支的源码声明。 |
| SDK 客户端 | 在 Node.js `v24.14.0` 下导入 v2 client 成功；合成请求验证 create/get/messages/abort 路由和含中文、空格的 cwd 编码。 | 客户端能在当前 Node.js 运行；合成请求不证明原生 Turn 行为。 |
| SDK 启动辅助函数 | 发布包 `dist/v2/server.js` 仍启动 `opencode`、写入 `OPENCODE_CONFIG_CONTENT` 并匹配 OpenCode 启动横幅。 | 不能直接用该函数启动 MiMo；必须由插件管理 `mimo serve`。[M4] |
| Kimi 原生服务 | 2.0.2 的鉴权 meta 请求成功；读取实际 `/openapi.json`、`/asyncapi.json`。 | 得到安装版本的接口 schema；OpenAPI 3.0.3 含 105 个 path 项，AsyncAPI 3.1.0 含 1 个 channel 项。这些是 schema 版本和规模，不是能力验收数。 |
| Kimi 空会话 | 创建成功、snapshot 读取成功；停止并重启原生服务后按同一 ID 读取成功。 | 同一原生空会话可持久化；非空历史恢复和继续生成尚未验证。 |
| MiMo 原生服务 | 0.1.14 的鉴权 health、SDK create/messages 成功；停止并重启服务后读取同一 ID 成功。 | SDK client 与当前 `mimo serve` 的基本接口可互通，空会话可持久化。 |
| 资源清理 | 最终探测的自有服务已退出，独立临时配置及会话目录已删除。 | 本次探测完成清理；产品级异常退出和并发清理仍需回归。 |
| 模型与工具 | 未提交模型 Prompt，共 0 个模型 Turn。 | 尚未验证真实流式回复、工具、审批、Question、取消终态、非空会话可写恢复或委派。 |

首次 MiMo 探测在 Windows `taskkill /T /F` 阶段返回子进程终止错误，因而在重启步骤之前中断。随后检查错误中列出的父子 PID，均已不存在；这与清理请求和进程实际退出之间存在时序差异相符，但不足以确定根因。探测脚本增加退出等待后，仅重新执行受影响的 MiMo 检查，空会话恢复通过，最终没有清理警告。实现时必须结合进程实际状态判断关闭结果，对仍存活的自有进程继续清理，不能无条件吞掉 `taskkill` 错误。

当前工作区的脱敏检查记录和下载的公开协议资料保存在 `.git/codex-probes/kimi-mimo/`，不参与提交或发行。其中 `sdk-verification.json` 记录合成 SDK 检查，`service-verification.json` 记录最终原生服务检查，`service-verification-initial.json` 保留首次失败记录。该缓存只用于本地追溯，克隆仓库后不保证存在；验收范围以本节和后续正式测试为准。

## 已核实的架构入口

| 源码 | 对本方案的约束 |
| --- | --- |
| [Adapter 与 Session 契约](../../packages/harness-adapter/src/text-session.ts) | 使用 inspect、open、execute、outputs、readSnapshot 和 close；Session 生命周期由公共契约表达。 |
| [插件工厂](../../packages/harness-adapter/src/plugin.ts) | 每个 Host 连接构造独立 Adapter；通过 Context 接收环境和可选启动配置。 |
| [Manifest schema](../../packages/shared-contracts/src/harness-plugins.ts) | 插件 API 版本、身份、入口和资源按现有规则校验；不能把运行时能力硬编码进 Manifest。 |
| [模型与能力 schema](../../packages/shared-contracts/src/harness-models.ts) | Model/Thinking 使用 opaque ID，权限区分 live 与 atCreate，Fork/Rollback 按真实能力声明。 |
| [共享路由](../../packages/shared-contracts/src/harness-route.ts) | 新插件使用 encodeHarnessPluginRoute / decodeHarnessPluginRoute，不增加专用 transport prefix。 |
| [Renderer Agent 状态](../../packages/renderer-extension/src/agent-selection-state.ts) | 当前仍有固定 Agent 联合类型和按 Agent 保存的模型配置，新增插件不会自动完成 UI 接入。 |
| [Renderer 路由绑定](../../packages/renderer-extension/src/versioned-renderer-adapter.ts) | 创建与恢复必须完整传递插件身份、模型、Thinking 和权限。 |
| [生产注入入口](../../packages/desktop-control/src/production-controller.ts) | 当前 enabledAgents 是显式列表，交付时须同步接入两个 Agent。 |
| [预装清单](../../scripts/release/harness-plugins.json) | 预装插件及受审查运行依赖由清单决定；Host 不静态引用具体 Adapter。 |
| [根 TypeScript 配置](../../tsconfig.json) | 项目 references 是显式列表，需要添加两个 Adapter；根 Workspace 通配符已覆盖 adapters 子包。 |

其余 Picker、图标、Settings、Sidebar 和恢复逻辑的具体修改点，实施时根据相关调用方与测试定位。本方案不把参考技能列出的历史接线清单视为全部仍需修改的源码事实。

## 原生接口选择

### Kimi Code

本机使用新版 Kimi Code 2.0.2；接入基线是 MoonshotAI/kimi-code，不沿用已归档 Python kimi-cli 的协议假设。

官方资料提供 `kimi web --no-open` 的 REST/WebSocket 服务接口，也提供 `kimi acp`。服务 API 明确标为实验性，需以安装版本提供的 OpenAPI/AsyncAPI 为准；ACP 文档列出会话加载、恢复、取消和配置操作。[K1][K2][K3][K4]

**首版实施方向确定为受版本约束的原生 REST/WebSocket Adapter。** 依据是安装版本的实际 schema、鉴权服务和空会话持久化均已验证，原生接口也提供历史与交互资源。真实 Turn、取消、审批和历史映射仍是 P0/P2 的完成门槛。仅在出现无法解决的具体原生接口缺口时重评 ACP；首版不同时建设两套 Transport，也不在恢复失败时静默切换协议。

实时路径先使用原生 session 事件流，历史路径使用按 Turn 分页的结构化 transcript，二者按原生身份归并。记录 durable 事件的 `seq`/`epoch`；文本等 volatile 增量不能依赖重放补全，需要按 `offset` 检查重复或缺口并通过 snapshot 修复。收到 `resync_required` 后刷新 snapshot 和游标。不要把 WS 序号当作可跨服务重启持久化的 Turn ID，也不要同时消费 legacy 和 transcript 两套流造成重复输出。[K3]

P0 必须重点确认历史稳定身份、流事件与终态对应关系，以及审批和提问是否可完整往返。原生存在 fork/undo 命令，不代表已经符合 Host 的精确 checkpoint Fork 或事务式最后一轮回滚语义。

### MiMo Code

官方 MiMo Code 是独立 CLI。本机 `mimo serve --help` 确认可启动 headless 服务，并支持 loopback 地址及自动分配端口。已核对官方源码和实际发布包 `@mimo-ai/sdk@0.1.14`，并用其 v2 client 连接本机 0.1.14 服务完成基本接口探测。[M1][M2]

**首版使用 MiMo 官方 SDK 的 v2 client + 插件自行管理的原生服务。** 实施基线锁定 SDK/CLI 0.1.14。通过 `@mimo-ai/sdk/v2/client` 导入仍沿用旧名称的 `createOpencodeClient`，可在插件内起语义清楚的本地别名；名称沿用不代表能替换成 `@opencode-ai/sdk`。[M4][M5]

发布包的 server helper 仍硬编码 OpenCode，首版不得调用它。插件直接启动发现的 `mimo` 可执行文件，使用 `serve --hostname 127.0.0.1 --port 0`，设置 `MIMOCODE_SERVER_USERNAME`、`MIMOCODE_SERVER_PASSWORD`，识别 `mimocode server listening on` 横幅，然后把地址和 Authorization 交给 v2 client。MiMo 的配置覆盖使用 `MIMOCODE_CONFIG_CONTENT`，目录传递由客户端处理 `x-mimocode-directory`；不要复制 OpenCode 的环境变量、HTTP header 或横幅字面量。[M4][M5][M6]

探测中的 pure 模式和隔离配置只用于验证，不应成为真实用户会话的隐式默认值。产品启动应保留用户选择的 MiMo 原生配置。发布包声明依赖 `cross-spawn@7.0.6`，首版仅使用 client 入口；发行时检查实际 Bundle 依赖，不为未使用的 server helper 自动扩大运行依赖白名单。

已有 [OpenCode 工厂](../../packages/adapters/opencode/src/plugin.ts) 和 [服务连接](../../packages/adapters/opencode/src/server-connection.ts) 可参考资源生命周期和 SDK 注入的组织方式。MiMo 使用自己的身份、认证和协议实现，不导入其他 Adapter 的私有模块。

## 最小实现设计

新增两个 Adapter 包，职责按实际复杂度拆分，通常包含 Manifest、插件工厂、Adapter/Session、原生 Transport、事件/历史转换和聚焦测试。不为统一文件数量创建空封装。

```text
packages/adapters/kimi-code/   # 新包，尚未创建
packages/adapters/mimo-code/   # 新包，尚未创建
```

复用 harness-adapter 与 shared-contracts 的公共类型、输出验证和错误结构，CLI 查找复用 harness-discovery。Kimi 原生 HTTP/WS 路径优先使用现有运行环境的 fetch 和已有 WebSocket 依赖；MiMo 按实际需求增加官方 SDK。只有出现语义一致的重复逻辑后才抽取共享模块。

启动入口可沿用公共 launchCommand 配置；必要时增加拟议的 `CODEXHOST_KIMI_COMMAND`、`CODEXHOST_MIMO_COMMAND` 显式覆盖。这些名称尚未实现。版本探测、命令名和安装布局属于各插件；找不到用户指定安装时返回明确错误。

服务应绑定 loopback，保持原生认证开启，正确清理自身创建的进程和连接。认证令牌不进入日志、Renderer、Manifest 或 Native Ref。不能因某端口可连接便接管用户正在运行的原生服务，也不能在关闭 Adapter 时终止不属于它的进程。

首版每次 open 使用独立受管原生进程，并在启动时应用该 Thread 的 environment；inspect 使用短生命周期资源。不同进程仍可使用用户的同一原生数据目录，但不能同时写入同一个 Native Session。关闭后再次 open 应用新的 Thread 环境，并恢复同一原生会话身份。真实工具执行现场是否得到正确环境，仍须验收。

已检查的创建 schema 没有提供经过验证的每会话环境注入路径，不能把任意 metadata 字段当成环境设置。共享服务容易沿用第一个 Thread 的进程环境；跨 Thread 共享必须先有隔离证据，首版不引入服务池或环境虚拟化框架。

## 分阶段执行与验收

### P0：锁定原生协议和可运行基线

已完成 SDK 发布产物、基本客户端请求、两套隔离服务和空会话持久化检查，结果见“续检结果与证据边界”。剩余工作是在本文补齐协议映射和真实 Turn 验证，不修改真实用户历史或全局配置。

- Kimi：沿用已读取的 2.0.2 schema 和 REST/WS 方向，补齐稳定 Turn/Item 身份、非空历史、流式输出、取消终态、工具审批、提问及错误码映射。
- MiMo：沿用已验证的 SDK/CLI 0.1.14，补齐正式依赖安装与独立打包、事件关联、取消、交互、非空会话恢复及同会话继续写入。
- 共同：使用隔离工作目录和明确的测试配置，确认检查操作不发送隐藏 Prompt；观察异常退出、超时、不同 cwd/环境和关闭后的资源清理。

本次已查询到版本标签：Kimi 2.0.2 对应提交 `9d07f634be94ebeb1deba2f55d247807cf729315`，MiMo v0.1.14 标签指向 `2a0eb706e95a77cba34a319e9f11f33f26d4450c`。这只锁定后续源码核对目标，并不证明在线文档与安装版本完全一致。

完成条件：首版 Transport、验证版本、认证前提和能力限制都有证据，真实 Turn 与公共语义的关键映射完成验证。当前已足以开始实现插件，但 P0 的真实交互验收尚未全部完成；空会话持久化不等于非空会话可写恢复。

### P1：MiMo 原生插件的完整基本会话

以官方 SDK 和受管服务实现 inspect、create、resume、turn.start、turn.cancel、interaction.respond、readSnapshot、close，配置选择按 P0 确认的原生范围实现。模型目录和实际生效状态来自原生，不写死模型列表或把 requested 值当 effective 值。

完成条件：通过真实 Loader 加载独立插件，能够连续执行两轮、观察工具结果、取消后继续，关闭并重开后恢复同一 Native Session。未安装、未认证、会话缺失、进程退出和协议错误有明确公共错误。

### P2：Kimi 原生插件的完整基本会话

沿用 P0 选定的单一 Transport，实现同一组公共会话行为。将实验性协议的版本校验和转换局限在 Kimi Adapter 内；不把原生字段扩散到 Host 或 Renderer。

完成条件与 P1 相同，并验证断开/重新连接后的历史与实时输出不会重复。固定默认模型、空目录或创建期权限等原生限制，须与 UI 就绪判断一起验证，不能用虚构选项绕过。

### P3：Desktop 与预装发行

接入 Agent 选择、配置草稿、任务恢复、Sidebar 身份、安装状态与必要 Settings 展示。两个 Agent 的模型、Thinking、权限和偏好隔离。新路由保持共享格式，未知或缺失插件不得回落到官方 Codex。

同步生产注入名单、两个包的 TypeScript references、构建产物与预装清单。MiMo SDK 及其实际运行依赖需要许可、Bundle 和发行白名单核对；不整体复制原生 CLI 源码作为 Host 依赖。

完成条件：用户能从 Desktop 创建两种任务、完成支持的交互和取消、切换任务后保持正确归属、重启后继续；打包插件在仓库外仍可通过 Loader 加载，不借用源码目录或开发 node_modules。

### P4：高级历史与委派能力

原生证据充分后再开放精确 Fork、最后一轮回滚、会话导入、原生命令及账号额度展示。接收委派复用普通持久化 Thread；继续向其他 Harness 委派需额外验证 Session 环境、工具可见性和父子任务归属。

不能把“支持文本调用”报告为“完整双向委派”。Fork/Rollback 尚未通过精确边界与源隔离验证时，能力保持不支持并隐藏相关控件，基础持久化会话不因此伪造高级能力。

## 必须保护的行为

| 场景 | 验收要求 |
| --- | --- |
| 持久化 | create 后得到真实 NativeSessionRef；Host 重启后恢复同一身份、同一历史并继续写入。恢复失败不创建空会话冒充成功。 |
| 历史 | readSnapshot 是只读操作；分页完整，Turn/Item 身份重复读取稳定；不将旧历史重新发往实时 outputs。 |
| 取消 | 接受取消请求与收到原生终态分开处理；旧轮终结前保持忙碌，迟到事件归属旧轮，后续输入只执行一次。 |
| 人工交互 | Approval/Question 保留关联标识、选项和取消语义；权限模式按原生能力映射，不自动回答问题以掩盖等待。 |
| 配置 | 原生确认后才更新 effective 状态；新旧任务、不同 Agent 和 Host 之间不串模型、Thinking 或权限。 |
| Fork | 校验指定 checkpoint，派生前缀准确且可独立继续；原生仅支持末尾 Fork 时不声称支持任意历史位置。 |
| 回滚 | 返回独立且少一个完整 Turn 的可写会话；不能在 Host 完成替换前对源会话执行破坏性的原地 undo。 |
| 环境与资源 | 每次 open 的环境到达原生执行现场；并发任务不串 Runtime/Thread 信息；部分启动失败和 close 不遗留自有资源。 |
| 错误 | 不可用、未认证、版本不兼容、会话缺失和原生退出可区分；诊断去除敏感信息。 |
| 现有 Agent | 公共契约、通用路由和已有配置读取行为保留，官方 Codex 路径及既有插件通过相关回归。 |

## 预计改动范围

| 范围 | 改动与原因 |
| --- | --- |
| 两个新 Adapter 包 | 原生协议、发现规则、生命周期、状态和历史转换，以及各自测试。 |
| 根 tsconfig.json、依赖与 lockfile | 添加项目 references 和核实后的 SDK 依赖；现有 Workspace 通配符无需扩展。 |
| scripts/release/harness-plugins.json | 添加两个预装包以及经过审查的必要运行依赖。 |
| Renderer 状态与路由 | 更新已核实的固定 Agent 类型及创建/恢复接线；按调用关系补齐 Picker、图标、偏好和状态展示。 |
| production-controller.ts 与相关测试 | 更新生产启用名单，并验证注入和 Renderer 支持范围一致。 |
| Loader / Host 集成测试 | 验证真实工厂加载、共享路由、持久化和不可用处理；不添加按 Kimi/MiMo 名称判断的 Host 业务分支。 |
| 功能文档与目录 | 实现后增加真实能力说明并更新 docs/index.md；本方案继续明确区分计划与已验证行为。 |

完整 Renderer 动态目录迁移、通用服务框架、账户迁移与无关依赖升级不纳入首版。若公共契约确有缺口，先给出最小公共扩展及受影响调用方，再确定是否进入当前范围。

## 实施时的检查计划

命令以当前 [package.json](../../package.json) 和 [Vitest 配置](../../tests/vitest.config.js) 为准。先安装锁定依赖，再根据实际改动选择检查；以下是待执行计划，不是本次通过记录。

```powershell
npm ci
npm run typecheck
npm run lint
npm run build:typescript
npm run build:renderer
```

聚焦测试使用 `vitest run --config tests/vitest.config.js` 加实际测试文件；覆盖两个 Adapter、真实插件 Loader、Host 公共路由与受影响 Renderer。UI 验收使用仓库现有 Playwright 配置，发行范围补独立 Bundle、搬移和 payload 检查。对修改文件执行 Prettier 检查，并执行 `git diff --check`。

真实原生测试另行记录版本、平台、认证前提、选定 Model、权限和每项结果。合成测试、构建和带认证原生测试分开报告。`npm start` 在 Windows 会影响正在运行的 Desktop，不作为常规验证命令。

规划阶段交付了协议探测记录。实施阶段已安装依赖，并执行 TypeScript、Renderer 和独立插件构建；已补充新 Agent 的路由、配置隔离、默认模型提交和缺失 CLI 浏览器用例。插件搬移加载与发行依赖/许可证检查沿用正式测试。真实 Provider/Model 与本机 Desktop 的端到端验收仍未完成；当前限制以实现文档为准。

## Jev 判断及未决事项

初稿的 Jev 记录对 Kimi 协议选择保留 insufficient_evidence。续检取得安装版本 schema 和基本服务证据后，本轮再次提交两项受限选择；返回 `ok=true`，选择 `native_rest_ws_first` 和 `per_open_process`。据此结合源码与本地探测收敛首版方案。Jev 结果只辅助设计判断，不代表实现、审查或测试完成。

尚未解决的关键问题是两套原生事件到稳定公共身份的完整映射、真实取消/交互、非空会话继续写入、工具环境隔离和独立发行。MiMo SDK 已发布、其 client 可用及 server helper 不匹配等问题已取得新证据，不再作为未知项；不能据此假定全部 MiMo 路由、配置更新或事件都与 OpenCode 兼容。

## 官方依据

- [K1：Kimi Code 当前官方仓库](https://github.com/MoonshotAI/kimi-code)。另核对 [旧 kimi-cli 仓库](https://github.com/MoonshotAI/kimi-cli) 的归档与迁移说明。
- [K2：Kimi CLI 命令](https://moonshotai.github.io/kimi-code/en/reference/kimi-command)。服务参数同时以本机 2.0.2 的 help 交叉核对。
- [K3：Kimi 原生服务 API](https://moonshotai.github.io/kimi-code/en/reference/server-api.html)。已与隔离运行的 2.0.2 `/openapi.json`、`/asyncapi.json` 交叉核对；在线文档仍不代替真实交互验证。
- [K4：Kimi ACP](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp)。文档声明不代替本项目公共契约验收。
- [M1：MiMo Code 官方仓库](https://github.com/XiaomiMiMo/MiMo-Code)。服务入口同时以本机 0.1.14 的 help 核对。
- [K5：Kimi 数据目录解析](https://github.com/MoonshotAI/kimi-code/blob/9d07f634be94ebeb1deba2f55d247807cf729315/apps/kimi-code/src/utils/paths.ts)。隔离探测使用其支持的 `KIMI_CODE_HOME`。
- [M2：MiMo SDK 源码包声明](https://github.com/XiaomiMiMo/MiMo-Code/blob/2a0eb706e95a77cba34a319e9f11f33f26d4450c/packages/sdk/js/package.json)。同时通过 npm registry 查询并下载 0.1.14 发布包核对实际导出与构建产物。
- [M3：MiMo 数据目录解析](https://github.com/XiaomiMiMo/MiMo-Code/blob/2a0eb706e95a77cba34a319e9f11f33f26d4450c/packages/shared/src/global.ts)。隔离探测使用绝对路径 `MIMOCODE_HOME`。
- [M4：MiMo SDK v2 server helper](https://github.com/XiaomiMiMo/MiMo-Code/blob/2a0eb706e95a77cba34a319e9f11f33f26d4450c/packages/sdk/js/src/v2/server.ts)。固定版本源码与 npm 发布包 `dist/v2/server.js` 均保留 OpenCode 启动字面量。
- [M5：MiMo SDK v2 client](https://github.com/XiaomiMiMo/MiMo-Code/blob/2a0eb706e95a77cba34a319e9f11f33f26d4450c/packages/sdk/js/src/v2/client.ts)。客户端导出命名和 MiMo 目录 header 的依据。
- [M6：MiMo 原生 serve](https://github.com/XiaomiMiMo/MiMo-Code/blob/2a0eb706e95a77cba34a319e9f11f33f26d4450c/packages/opencode/src/cli/cmd/serve.ts) 与 [Flag 配置](https://github.com/XiaomiMiMo/MiMo-Code/blob/2a0eb706e95a77cba34a319e9f11f33f26d4450c/packages/opencode/src/flag/flag.ts)。原生启动横幅和 `MIMOCODE_*` 配置的依据。
