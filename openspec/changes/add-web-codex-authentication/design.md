# Design

## Context

范围见 [proposal](proposal.md)。本设计保留现有执行路径，只增加认证操作及其必要的安全边界，因此需要记录跨包契约。

- `adapters/codex/src/plugin.ts` 的 `inspect()` 只读 `model/list`，控制连接由 Adapter 持有；每个 `CodexSession` 另有原生进程。
- `host-runtime/src/web-codex-harness.ts` 缓存 inspection；`web-codex-owner.ts` 通过固定 scope/epoch 分发请求，并已有失效通知。
- `session-runtime` 已有 `activity()`、原生空闲释放和队列投影；认证只需要复用这些事实，不建立第二个执行管理器。
- Web 的设置插槽在没有当前 Thread 时也可使用。现有 Harness 菜单会禁用失败条目，不能把登录入口仅放在该菜单中。
- `codex-multi-account-removal` 明确移除了 GUI 多账号管理。本变更显式增加隔离 Web 单个 home 的原生登录例外，不改变 GUI 账户页或旧方法的归属。

### 可复用的已有实践

| 来源 | 已核实的做法 | 本变更采用的部分 |
| --- | --- | --- |
| [Paseo，固定源码](https://github.com/getpaseo/paseo/blob/4d8bed9ddda9c896cc88cac4c3925622c36b35c0/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L3617-L3659) | 原生 app-server、stdio、Session 连接及恢复 | 不改变当前接入方式或每会话进程；不照搬其默认复用 CLI home 的配置策略 |
| [T3 Code，固定源码](https://github.com/pingdotgg/t3code/blob/339179f50a84dc599cce373dbb48f172f182f44e/apps/server/src/provider/CodexProvider.ts#L488-L511) | `account/read` 先于模型可用性判断 | 检查 `account` 与 `requiresOpenaiAuth`，不照搬应用自管 OAuth |
| [CodexMonitor，固定源码](https://github.com/Dimillian/CodexMonitor/blob/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5/src-tauri/src/shared/codex_core.rs#L627-L741) | 通过 app-server 发起原生登录 | 沿用原生登录生命周期；Web 选择设备码而非 localhost 浏览器回调 |
| [官方认证协议](https://developers.openai.com/codex/app-server#auth-endpoints) | `chatgptDeviceCode`、完成通知、取消 | 只实现这一个登录方式；原生 CLI 继续管理存储和 token 刷新 |

## Decisions

### 1. 只增加可选、有限的插件认证能力

在 `harness-adapter` 公共导出中增加可选 `authentication` 能力：读取、开始、取消及状态失效订阅。只表达认证是否满足要求、一次设备码 challenge 和其完成结果；不提供账户列表、token 导出、退出、切换、通用 OAuth driver 或任意 RPC。

浏览器安全的状态和参数校验放在 `shared-contracts`；原生 `account/*`、登录 ID、错误识别及通知时序留在 Codex Adapter。其他插件不必实现，Host 不导入具体 Adapter。Codex 可增加聚焦的原生认证模块，不重写整个迁入 Adapter。

### 2. 检查复用现有 inspection，而不是新增就绪状态机

`inspect()` 先通过控制连接执行 `account/read({ refreshToken: false })`。缺少所需 OpenAI 认证时返回现有错误码 `authenticationRequired`；不要求 OpenAI 认证的 Provider 和已有原生 API Key 继续按原配置检查模型。网络、协议或进程错误保留为检查失败，不统一包装成未登录。

不通过读取 `auth.json` 探测凭据，不发送测试推理，不改写 Provider。控制 RPC 有界超时；用户等待验证不占用短 RPC 超时，也不能被误判为检查成功。先按所用 CLI 的离线 schema 核对设备码字段与错误格式；不兼容时报告不支持，不自动替换 CLI 或改走另一种登录。

### 3. 登录只有一个 owner 和一条流程

Adapter 复用已有控制连接，先注册完成通知，再发 `account/login/start`，固定类型为 `chatgptDeviceCode`。返回值只含本次 opaque 身份、原生 HTTPS 验证链接和验证码。完成事件须与本次登录关联；取消调用原生 cancel，并防止旧取消或旧完成事件影响新的登录。

同一 home 只有一次待处理登录；重复开始返回现有 challenge。认证满足要求时不启动新登录，只有明确需要认证或原生认证失败才提供该操作。开始结果未知时不得立即再发一次；先核对原生状态，必要时在空闲边界确认控制进程退出以结束旧尝试。

shared 的唯一 owner 持有该能力；standalone 使用自身已有 composition 和同一 Adapter 实现。网关断开不取消 shared 登录。owner 关闭时结束其原生控制连接与订阅；重启只读取原生已保存认证，不持久化或恢复 challenge。

### 4. 认证变化与执行互斥，不中断任务

登录准入与提交准入在来源 owner 串行判定，复用 `activity()` 与后台工作事实。有活动工作、未决提交或交互则返回忙碌；不能通过停止任务或清空队列获得空闲。

在 `session-runtime` 现有释放路径上增加窄的空闲资源释放入口，供两种 composition 使用。登录前确认闲置执行进程已退出，之后保留 metadata/nativeRef，用户下一次提交按既有 resume 路径重建执行进程。关闭未确认则拒绝登录；登录期间执行请求明确返回忙碌，不暂存成第二套队列。历史读取仍可用，但不得因读取而恢复执行进程。

明确的原生模型认证失败映射为 `authenticationRequired`，通知 Adapter 使检查结果失效。只在该错误分支保留并暂停现有队列，不消耗后续条目；已暂停队列不阻止登录。登录完成不自动继续队列，用户仍用现有发送、编辑、删除入口处理。不改其他失败的队列规则或新增队列持久化。

### 5. 固定操作复用现有通道

浏览器仅增加 `codexhost/web-codex/authentication/read|start|cancel`，shared 网关映射到现有 Web Codex request 的三个固定操作；不接受 home、CLI、插件、Provider 配置、原生方法名或 token 参数。

既有配置响应增加可选的认证能力标记；缺失时关闭新登录入口并提示版本不支持，不增加能力协商服务。所有入口沿用现有 scope、epoch、Web 认证与同源校验，旧 `codexhost/account/*` 方法不恢复。

认证事件复用 owner 的 `web-codex-changed` 通知，网关转为一个不含凭据的浏览器认证失效事件。状态读取、重连和手动检查返回权威快照；不新增 WebSocket、定时轮询或持久日志。

### 6. 刷新必须贯穿缓存和执行

认证变化后清除 `web-codex-harness` 及 standalone registry 的相关 inspection 缓存，并使在途旧结果不能回写。浏览器现有模型目录服务响应认证失效事件重新读取，不再复用旧失败或旧就绪结果。401 后仅有旧账户元数据不算重新确认；原生登录完成或已确认的原生凭据更新后才允许清除该认证失败。

通过空闲释放使后续执行进程读取当前认证，不尝试在多个活动进程中注入或轮换 token。不会改变其他 Harness 的目录、默认偏好或用户选择；保留草稿和失败 Turn，不自动提交。

### 7. Web 只增加一行设置

使用 `ui-codexhost` 现有 `settings.general.item` 插槽展示“Web Codex”，不新增账户页。包含状态、检查按钮、需要认证时的登录按钮，以及待验证期间的链接、验证码和取消按钮。未启用来源则不显示；未安装、检查失败和旧版本明确显示原因。

challenge 只保留在 owner 与已授权浏览器内存中，不进入 localStorage、Thread journal、诊断或日志。浏览器不收到 API Key、access token 或 refresh token。设置行不依赖模型目录成功，不改 Harness 菜单的禁用规则。

## Risks / Trade-offs

- [设备码被账户策略禁用或 CLI 不兼容] → 展示原生失败或不支持；保留既有配置方式，不增加第二套登录流程。
- [原生认证成功仍可能没有模型权限或可用额度] → 只报告认证与检查事实，最终由真实 Turn 结果决定；不添加自动推理探针。
- [重登录影响同 home 的闲置进程] → 仅在无活动工作时确认释放，保留原生身份后按需恢复；不重启整个 Host 或 GUI。
- [原生模型 401 与普通工具 HTTP 错误混淆] → 仅识别版本核实过的原生认证失败；工具正文不参与分类。
- [部署形态变化] → 本提案针对现有本地、自用 Web；[官方当前边界](https://developers.openai.com/codex/app-server#auth-endpoints)不等于允许把 CLI OAuth 用作商业托管服务。应用自管 Sign in with ChatGPT 不纳入本次。

## Migration

不新增凭据文件或改变 home、Thread 身份、journal 格式，无数据迁移。部署时更新插件、owner 和 Web；旧 owner/插件缺少能力时仅新登录入口不可用，不能以本地 fallback 绕过。更新已运行的后台仍须用户在任务空闲时安排，不能因构建完成自动重启。

回滚前取消待处理登录或正常停止已空闲的 owner。原生登录产生的凭据由 CLI 保留，不删除、不复制；旧版本仍可使用既有原生配置，但不宣称保留新增认证检测。
