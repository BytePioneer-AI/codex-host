# ZCode 官方账号模型接入：背景与候选方案

> 状态：隔离预验证、配对探针及可选 Desktop 后端接线已实现；真实 Desktop 配对与官方账号调用仍待验证。保留原 stdio 路径，不增加固定官方模型、不实现凭据复制或独立账号桥。
>
> 本文不代表已经支持官方账号。当前能力以 [ZCode Harness 接入](zcode-harness-integration.md)为准。

## 背景与目标

当前 ZCode Adapter 能读取自定义 API Key Provider，但用户在 ZCode Desktop 中可选择的官方 BigModel 模型没有出现在 codexhost 中。观察到的官方模型为 `GLM-5.3-Flash` 和 `GLM-5.3`，账号方案为 Start Plan（界面显示“体验”）。

目标不是只显示这两个模型名称，而是在 codexhost 的独立 Thread 中使用 ZCode Harness，并按原生账号权益及计费语义执行请求。以下目标不能混为一谈：

- **接入 ZCode Harness**：保留它的 Agent Loop、工具、权限、历史和 Native Session。
- **调用 GLM Model**：其他 Harness 也可能通过兼容的 Provider 调用 GLM，不等于接入 ZCode。
- **使用官方账号方案**：需要原生账号、权益和请求认证；另行配置 API Key 不自动继承 Desktop 中的体验额度。

当前 Adapter 在可用模型目录为空时返回 `authenticationRequired`。这是 Adapter 的错误分类，不足以证明用户未在 ZCode Desktop 登录。

## 原有 stdio 接入方式

```text
Codex Desktop
    ↕ codexhost 公共 Harness 契约
ZCode Adapter
    ↕ 双向 JSON-RPC / stdin、stdout
Host Node → resources/glm/zcode.cjs app-server --stdio --surface terminal
    ↕
Model Provider
```

这条 stdio 路径不是 ACP，不是终端输入模拟，也不连接正在运行的 ZCode Desktop。每个已打开的 Session 独立拥有一个原生进程。

Adapter 支持两种实际接口集合：旧的工作区 Registry，以及新版进程级 Registry。只有 `workspace/readState` 明确返回方法不存在时才切换路径；不按操作系统或版本字符串判断。新版路径通过无提示词、延迟持久化的临时 Session 读取原生模型目录，随后关闭。

这解决了接口兼容问题，但没有补齐 ZCode Desktop 对官方账号的管理职责。

## 调研依据与验证边界

调查对象为 Windows ZCode Desktop `3.12.3`，内置运行时报告 `0.16.5`。以下路径相对于安装目录；ASAR 内文件及打包符号属于版本相关实现细节，不是稳定公共 SDK。

| 证据位置 | 确认的行为 |
| --- | --- |
| `resources/glm/zcode.cjs` | app-server 初始化进程级 Registry；接收账号配置同步；模型请求前通过反向 RPC 获取认证材料。 |
| `resources/config/provider/zcode-builtin.json` | 声明官方账号型 Provider、方案类型和内置模型；这些声明不等于当前账号具有可用权益。 |
| `resources/app.asar` 内 `out/host/index.js` | Desktop 解析账号连接与权益，向 Agent 同步账号配置，并提供请求认证。 |
| ASAR 内 `out/host/chunk-3CQYXRMM.js` | 原生服务客户端包含模型选择、Provider 设置、Agent 和 Session 等服务。 |
| ASAR 内 `out/preload/index.cjs` | Desktop 通过 Electron MessagePort 向 Renderer 提供原生服务连接。 |
| ASAR 内 `out/renderer/assets/styles-ou2or4Yg.js` | Start Plan 的验证码配置获取、官方 SDK 调用、请求前验证、重试和取消流程。 |

本地配置检查仅输出了 `setting.json` 中允许查看的账号体系和方案字段，确认该案例选择 `bigmodel` / `start-plan`；未读取或解密凭据文件，文档不保存用户凭据或完整配置。

已执行的隔离探测使用安装的原生运行时、临时 HOME/数据目录、空个人 Provider 配置，不进行账号同步、不发送提示词。原始 Session 快照的可用模型数为 0，临时 Session 随后成功关闭。这证明仅有内置官方 Provider 声明不会自动生成可用目录；结合代码中的账号同步流程，可解释该案例，不应归因于 Renderer 漏显示模型。

此前通过的 Windows 原生生命周期测试使用本地模拟 Provider，不能作为真实官方账号对话的验收。尚未验证真实授权配对下的外部 Adapter 连接、官方模型调用、验证码交互及其跨版本稳定性。调研没有重启 ZCode、开启调试端口或发送官方模型请求。

## macOS 隔离可行性预验证

在 macOS 安装的 ZCode Desktop `3.12.3` / Electron `41.0.3` 上，已执行 [Desktop 服务探针](../../../packages/adapters/zcode/prototypes/desktop-services.mjs)。这是明确标记为 throwaway 的研究代码，不参与插件加载或发行。

探针使用安装包未修改的 `out/host/index.js`、原生 RPC 模块和内置运行时。在 Electron 的 Node 模式下启动隔离 Host，仅将 Node MessagePort 事件形状适配为 UtilityProcess 的形状；没有替换账号、模型目录或 Session 实现。入口依赖该版本的私有 Bundle 和具名导出，**不构成稳定外部接口**。

每次运行使用短路径临时 HOME、数据目录和数据库。macOS sandbox 禁止读取真实 HOME、临时目录外的文件写入、向其他进程发送信号和 TCP/外网访问，仅允许临时目录内的 Unix socket；启动器在删除临时目录前按 cwd 核验、回收属于该目录的进程，包括脱离父进程组的原生 CLI；清理失败则保留目录并报错。仅杀父进程组曾遗漏子进程，已增加普通 Node 进程回归与原生运行后的残留检查。不连接正在使用的 ZCode Desktop，不读取登录凭据，不开启远程控制或调试端口。原生后台配置刷新在隔离环境下可能失败，不以联网刷新成功作为验收要求。

在仓库根目录运行，无需构建插件：

```sh
node packages/adapters/zcode/prototypes/desktop-services.mjs
node packages/adapters/zcode/prototypes/desktop-services.mjs --personal-fixture
```

两条命令均已返回退出码 0、`passed` 和 `scratch-profile-removed`。系统签名检查可能输出 sandbox 的 `EPERM` 提示，本次未影响断言结果。

| 检查 | 实测结果 |
| --- | --- |
| 空账号与空个人配置 | 原生目录为 0；`createSession` 明确拒绝无可用 Provider/Model，不凭内置声明生成官方目录。 |
| 原生服务连接 | `init-local` 后可通过 ChannelClient 调用 `modelSelectionService.getView()`。 |
| 第二个 attachment | `attach-service-port` 接受 `web-remote-replayable` 模式；关闭第一个连接后，第二个仍可读取目录。 |
| 个人 Provider 对照组 | 仅配置一个测试模型，地址为 `http://127.0.0.1:1`、Key 为测试值；目录准确返回 1 个 Provider / 1 个 Model。没有启动模型服务或发送 Prompt。 |
| 独立 Session | 创建两个 `persistence: deferred`、禁用标题生成、空 MCP 列表的 Session；身份不同、消息为空。 |
| 关闭隔离与清理 | 关闭第一个 Session 后仍可读取第二个；关闭全部临时 Session 后，原生 Session 列表为空。 |

**验证结论仅限底层服务及空 Session 生命周期可用。** `web-remote-replayable` 是本次 attachment 的连接模式，不代表已经完成外部 Relay 握手、配对授权或账号接入。官方 GLM 目录、Start Plan 验证码、真实请求、恢复和 Thread 级环境传递均未通过本探针验收；不能以个人 Provider 对照组替代官方账号验收。

### 新发现的候选入口：Web Remote Control

安装包 `out/main/index.js` 中存在原生 Web Remote Control：用户配对后，通过 Relay 转发 RPC，为目标工作区建立新的 MessagePort attachment，并单独释放连接。这比直接抓取 Renderer 内部对象更值得优先验证，但仍不是已承诺兼容的第三方 SDK。

需要单独验证和授权的事项：

- 在用户已登录的 Desktop 中开启原生远程控制并为探针配对；不读取保存的配对秘密，也不将配对链接写入日志或提交。
- Relay 引入外部网络与数据转发；已观察到窗口级当前 bridge 状态，需验证是否影响既有手机连接和多工作区并发。
- 工作区必须能被原生窗口的授权列表解析，不能假定任意 cwd 可用。
- 原生 Renderer 按工作区订阅认证请求，为独立 Session 复用验证码提供了静态依据；是否真正覆盖外部创建的 Session 尚待实测。
- 已检查的 Session 创建参数没有任意环境变量入口。现有 `OpenSessionInput.environment` 的 Thread 级覆盖及委派身份不能静默丢弃，也不能写入 Desktop 共享进程环境冒充隔离。

下一验收点是经原生配对读取真实目录、创建并关闭无提示词的独立 Session；真实模型调用与验证码另行确认。前三阶段的停止条件仍适用，隔离预验证不等于已完成外部连接阶段。

### 配对探针实现与使用边界

已实现 [paired-desktop.mjs](../../../packages/adapters/zcode/prototypes/paired-desktop.mjs)，仅用于 macOS 安装的 Desktop `3.12.3`，不注册为生产 Adapter。`paired-relay.mjs` 处理 terminal 角色的原生 challenge-response、消息关联、超时和关闭；`paired-catalog.mjs` 只请求工作区列表、连接指定工作区，以及创建和关闭自己的临时 Session。Relay 帧分片、确认与 ChannelClient 继续使用安装包的原生实现。

**真实探针不调用 `modelSelectionService.getView()`。** 静态检查发现该视图中的个人 Provider 配置会包含 `apiKey`，因此不能将其当作不含凭据的模型目录接口。此前隔离探针仅在空配置或测试 Key 下调用它。配对探针改为读取自己的 deferred Session 快照，只输出可用 Model 的 Provider/Model ID、名称和 Thinking 选项；不调用 Provider 设置或凭据服务，不读取已有对话，也不发送 Prompt。

无需登录态的检查：

```sh
node packages/adapters/zcode/prototypes/paired-desktop.mjs --check
node packages/adapters/zcode/prototypes/desktop-services.mjs --paired-fixture
npx vitest run --config tests/vitest.config.js packages/adapters/zcode/prototypes/paired-probe.test.mjs
```

`--check` 已通过本机安装包的原生 Relay 编解码回环；`--paired-fixture` 已通过同一配对探针逻辑、原生 Relay 编解码、ChannelClient 和隔离 Host 的创建/关闭链路，最终持久化 Session 为 0。后者的配对与工作区发现是内存模拟，不连接官方 Relay，不能证明真实账号可用。另在同等 sandbox 下确认了官方 WSS 的 TLS/WebSocket 连通性，握手后即关闭，未发送认证或应用消息；这不算配对验收。聚焦测试覆盖 URL/版本校验、认证证明、消息关联、超时、冲突不重连、身份与清理边界，以及输出不包含额外凭据字段。

真实验证必须由用户通过 ZCode 原生界面启用 Web Remote Control、复制原生连接链接，并确保目标工作区在该窗口中打开。在对应工作区的终端执行：

```sh
pbpaste | node packages/adapters/zcode/prototypes/paired-desktop.mjs --cwd "$PWD" --pairing-stdin
```

- 链接只从 stdin 进入内存，不放在命令参数、对话、文件或日志中。仅接受正式 `https://zcode.z.ai/remote/v4`、版本 `3.12.3` 的链接；Relay 固定为 `wss://zcode.z.ai/ws`，不接受链接指定任意后端。配对证明按原生协议计算，不转发明文配对 Hash。
- 子进程使用临时 HOME、清空的环境及 sandbox，不能读取真实 HOME 或写入临时目录外的文件。与完全离线的隔离探针不同，此模式需要访问官方 Relay。配对权限可能覆盖整个原生窗口，并可能替换现有手机连接；客户端只发上述有限调用不意味着服务端授权已缩小。
- 不打开调试端口、不读取已保存的配对秘密、不重启 Desktop。当前没有验证可从外部自动操作原生配对入口，需要用户在原生界面完成这一步。
- Session 采用 `persistence: deferred`、禁用标题生成、空 MCP 列表，不改 Model 默认值。成功输出 `catalog-probe-passed` 必须先确认该 Session 已按 `expectedPersistence: deferred` 关闭；不会调用 `session/list` 扫描用户会话。
- 本机原生实测确认：普通 `createSession` 拒绝客户端指定 ID（`sessionId is only supported for imported history creates`）。探针使用原生返回且通过工作区/空历史校验的身份，不为取得固定 ID 改走历史导入。创建回执丢失、异常快照、强制退出或断线时，可能无法确认临时 Session 的清理；返回明确失败，不重试创建、不猜测 ID 或关闭其他会话。
- Relay 冲突、断开、未知协议或失败均停止，不自动抢占重连，不切换到自定义 API Key 或其他计费来源。配对成功、空 Session 成功仍不等于官方模型对话成功。

尚未输入用户的原生配对链接，未完成真实 Relay/账号验收，也未调用官方模型或验证码。后续实现已把配对设置、原生目录和 Session 路径接入既有 Adapter，增加公共连接设置及共享服务环境契约；沿用既有 Picker 路由与预装插件。使用方式、能力限制及原生合成历史恢复验证见 [ZCode Harness 接入](zcode-harness-integration.md#可选desktop配对后端)。这些代码接线不等于官方 GLM 验收通过。

## 缺失的原生链路

### 账号权益与模型目录同步

Desktop 的原生账号服务读取账号连接、当前方案和权益，生成账号 Provider 配置，然后调用：

```text
provider/updateAccountConfig
```

同步内容包括 `revision`、`basedOnZCodeBuiltinRevision`、Provider 配置，以及 `availability`、`entitled`、`current` 等状态。Start Plan 的模型列表还会结合服务端权益数据生成。

app-server 的该账号配置来源等待调用方同步，并不因为能读取 `provider_config.json` 就自动拥有 Desktop 的账号状态。stdio Adapter 未执行这段同步；可选 Desktop 后端调用已有原生服务，由 Desktop 自己执行同步。

该接口不能替代旧版任意 Provider 注册接口，也不能通过手写 `entitled: true` 让模型假装可用。

### 每次请求的认证材料

官方模型请求前，运行时通过反向 RPC 请求：

```text
interaction/requestProviderRuntimeHeaders
```

Desktop 根据原生账号状态提供 `requestAuth`。被调查版本中的主要路径为：

| 方案 | 原生认证来源 |
| --- | --- |
| Start Plan / 体验 | 账号的 ZCode JWT。 |
| 个人 Coding Plan | 对应方案的请求密钥。 |
| 团队 Coding Plan | 按组织、项目解析的请求密钥。 |

stdio `session.ts` 未处理该反向认证请求；可选 Desktop 后端不自己处理凭据，依赖原生 Desktop 服务。即使能读取目录，也不能据此证明原生认证及验证码已可用于外部 Session。

### Start Plan 验证码

Renderer 从 `codingPlanSubscriptionService.getCaptchaConfig()` 获取配置，调用官方 SDK，执行无感验证或用户交互。结果通过原生响应携带验证码相关请求头：

- `X-Aliyun-Captcha-Verify-Param`
- `X-Aliyun-Captcha-Verify-Region`

代码包含发送前验证、`captcha-retry`、请求关联、排队及取消处理。不能将一次验证码结果作为长期静态配置或跨请求重复使用，也不应以自动绕过验证替代原生流程。

独立 CLI 的账号实现中，调查到的 standalone 路径明确处理 `individual-coding-plan`。其存在不证明当前 app-server 会自动继承登录，也不能作为 Start Plan 体验方案的替代路径。

## 方案比较与当前决定

| 路线 | 优点 | 约束与结论 |
| --- | --- | --- |
| 保持 app-server，使用自定义 Provider | 已有原生协议和生命周期实现，不增加 Desktop 依赖。 | 当前采用；不承诺官方体验额度。 |
| 固定两个官方模型名称 | 只需改变显示或筛选范围。 | 无法解决权益、认证、验证码，不作为接入方案。 |
| 保持 app-server，补充官方账号与认证桥 | 可以保留现有 Session 执行路径。 | 需要取得真实账号配置及逐请求认证，并处理验证码；目前没有验证可复用的外部桥，不能只复制 Token。 |
| 通过 ZCode Desktop 原生服务执行 Session | 有机会直接复用原生账号同步、认证和验证流程，减少重写账号逻辑。 | 隔离服务与配对探针原生链路已通过；可选 Adapter 路径与设置已接线；真实 Relay/账号仍待原生配对验收。 |
| 换为一次性 CLI 调用 | 单次输入输出简单。 | 不自动解决 Start Plan；恢复、工具审批、取消和历史仍需适配，不能作为当前完整能力的等价替换。 |
| 独立 CLI 的个人 Coding Plan 路径 | 安装包中存在相应原生实现。 | 可另行研究，但不解决本案例的体验方案，且与 app-server 的衔接未验证。 |
| 在其他 Harness 中配置 GLM API Key | 如果仅需模型，可不接入 ZCode。 | 使用该 Key 对应的认证及计费，不继承 ZCode Harness 行为或体验额度。 |

当前采用：保留 app-server 和自定义 Provider，同时提供显式配置的实验性 Desktop 路径。用户要求实施后补齐了设置和执行接线，但真实账号验证仍是启用验收的前提；未配置配对时不改变原后端，暂不承诺官方体验方案可用。

## 候选方案：Desktop 协作模式

以下描述 Desktop 路线的职责与待验收要求；已经提供的实验性配置以接入文档为准。

```text
codexhost ZCode Adapter
    ↕ 用户授权的原生服务连接（入口待验证）
ZCode Desktop 原生服务
    ├─ 模型目录、账号连接和权益
    ├─ 独立 Native Session
    ├─ 请求认证
    └─ 原生 Start Plan 验证流程
```

安装包中的 `modelSelectionService`、`providerSettingsService`、`zcodeAgentService` 和相关 Session 服务是调查入口。原生 `createSession`、`resumeSession` 等流程已经包含账号配置同步。但这些服务通过 Desktop 内部的 MessagePort / ChannelServer 通信，不是现成的外部 HTTP API；服务存在不等于外部接入已可行。

优先验证完整原生 Session 服务，而不是从安装包提取凭据或复制鉴权代码。不能通过模拟聊天窗口点击、借用用户已有对话、修改 ASAR 或绑定混淆函数名来假装建立了稳定接口。若只有私有调试连接可用于实验，需明确其版本与安全限制；不得把无认证的常驻调试端口作为产品接口。

### 模型范围

首个原型可聚焦 BigModel Start Plan 中的 `GLM-5.3-Flash` 和 `GLM-5.3`，但仅作为测试及支持范围：

1. 从原生模型目录和账号状态判断是否实际可用。
2. 保留原生 Provider/Model 身份及 Thinking 选项，不只用模型名称区分。
3. 登出、权益变化或模型下架时，不继续报告可用，也不静默改用另一账号或计费来源。
4. 自定义 Provider 保持原行为，不被这两个模型的范围限制。

### Session 所有权与兼容性

- 通过原生接口创建 codexhost 自己的独立 Native Session，不复用用户正在使用的对话。
- 原生 Session 的事实来源保持唯一，不能让 stdio 和 Desktop 两套路径并发控制同一 Session。
- 如果最终需要共存两种执行路径，明确记录恢复所需的来源信息；恢复失败时不得静默换后端或创建空会话。具体表示需在原型通过后核对现有契约，不预先扩展公共协议。
- Desktop 路径关闭时只释放自身 Session、订阅和连接，不能套用现有 stdio 的进程树终止逻辑去关闭整个 ZCode Desktop。
- 验证工具审批、问题交互、取消、断线和终态去重，避免 codexhost 与 ZCode Desktop 同时响应同一交互。
- 验证工作区身份、会话级运行环境、Skills、工具进程及委派环境。不能假设 Desktop 管理的共享进程具备当前独立进程的全部语义。
- 历史、Fork、修订、文件 diff、压缩、Goal 和子代理逐项验证。不得用会回退工作区文件的旧 Fork 操作代替 codexhost 的上下文分叉。

### 验证码与安全

优先让 ZCode 的原生界面承接必要验证。需要确认 Adapter 创建的 Session 能被对应工作区的原生验证码订阅识别，验证结果能够返回同一请求。

覆盖无感通过、弹窗、取消、超时、重试、多 Session 并发和 Desktop 退出。取消后不得把迟到的认证结果提交给下一次请求。

不把 OAuth Token、API Key 或验证码结果持久化到 Host 映射、插件设置、Renderer 存储或日志。外部连接必须有明确授权和作用域；不暴露通用凭据读取接口，不伪造权益或绕过验证。真实请求可能消耗官方额度，应作为另行确认的验收步骤，而不是连接诊断自动执行的动作。

## 分阶段验证与停止条件

| 阶段 | 需要证明的事实 | 停止条件 |
| --- | --- | --- |
| 1. 连接原型 | 用户授权下能取得原生服务连接，范围可控，断开可清理，不修改安装包。 | 找不到可靠入口，或只能依赖未经授权的连接、抓取秘密及脆弱函数补丁。 |
| 2. 真实模型目录 | 能读取当前账号实际可用的官方模型，区分未登录、无权益、验证待处理和运行时故障。 | 只能硬编码目录或假设权益。 |
| 3. 独立 Session 与对话 | 创建独立 Session，完成一次经过原生认证及必要验证码的短对话。 | 只能显示模型、只能复用既有用户对话，或验证结果无法关联请求。 |
| 4. 生命周期与隔离 | 取消后继续、关闭、重连、恢复可用，且不影响其他 Desktop Session。 | 必须终止整个 Desktop，或无法确保身份、恢复及终态语义。 |
| 5. 能力回归与产品化 | 核对既有能力、账号失效、并发验证、版本兼容及旧接口回归，文档与能力声明一致。 | 仅凭一次对话成功就保留未验证的完整能力声明。 |

前三阶段仍未完成，不能把实验性接线包装为官方模型支持，也不承诺真实可用日期。macOS 已补充生产 Adapter 对接隔离原生服务的目录、空 Session、合成持久历史恢复验证；真实 Desktop 配对、其他版本及跨平台能力仍需独立验收。

## 预期代码边界

当前实现及持续验证遵循以下边界：

- `packages/adapters/zcode/`：原生 Desktop 连接、模型目录、Session 创建/恢复、事件及交互映射。按职责新增模块，复用语义相同的历史和输出投影。
- `adapter.ts`、`session.ts`、`transport.ts`：核对执行路径、请求分发与资源所有权，不把 Desktop 服务伪装成可随意终止的自有子进程。
- Adapter 测试：补充原生服务 fixture、失效与取消边界，保留已有双协议回归；fixture 不替代真实账号验收。
- Host/Renderer：不预先新增 ZCode 专属账号流程。如果必须由 codexhost 展示新的授权交互，先明确公共契约缺口，再评估单独扩展；不得让 Renderer 导入 Harness SDK 或 Electron 私有 API。

不改变 Rust、Host Runtime 与 Adapter 的职责边界。现阶段保留本方案和隔离/配对探针，新增可选 Desktop 执行后端与通用设置接线，但尚不宣称真实官方模型支持已通过验收。
