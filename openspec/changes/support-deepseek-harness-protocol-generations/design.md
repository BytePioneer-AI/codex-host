## Context

当前 `DeepSeekHarnessAdapter` 通过 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2` 连接无浏览器认证的 loopback Host，读取分页历史和 Mux/Host 事件，并直接调用旧 `sessions.*`、`settings.*` 与命令 Remote。DSH 提交 `4f00a8b82a` 在 `0.1.2-alpha.1` 发布前删除了整个 ApiProxy 包；经 alpha.4/alpha.5 验证并由 `0.1.2-rc.1` 发布的 Modern Web 应用改为：

- 启动输出携带 process bootstrap token 的 URL；根页面交换 token 后签发 Host-only、HttpOnly、SameSite=Strict cookie；
- 一元调用使用 `POST /api/<endpoint>` 的 Typert Remote envelope；
- 流调用使用 `/api/remote.mux` WebSocket 上的 logical stream；
- `session/follow` 提供有界 opening window 和连续 live event，较早历史通过固定 `throughSeq` 的 `session/page` 读取；
- `session/control` 提供完整 projection baseline 和 live replacement update；
- `$events` 转发 approval/question waterfall，并由 `$events/result` 结算；
- `session/*`、`commands/*` 和 settings Remote 提供当前 CH 所需的原生控制。

Modern ACP 不提供 transcript replay、Fork、commands 和 elicitation；SDK 也不足以满足 CH 的恢复、命令和交互契约，所以二者不作为本变更的降级传输。

## Goals / Non-Goals

**Goals:**

- 同一 CH 构建只支持经过独立 Gate 的 Legacy `0.1.1-rc.2` 与 Modern `0.1.2-rc.1`。
- 两代源码、原生类型、解析器、状态机和测试有明确边界；版本选择只发生一次。
- Modern 恢复现有 DSH 能力：创建/恢复、完整历史、实时 Turn、autonomous Turn、Model/Thinking、Permission、Approval/Question、Usage、命令、取消和同 cwd Fork。
- 所有 Remote envelope、stream frame、history record、projection、interaction request 和结果均在信任边界严格校验并受有限工作量约束。
- 保持 DSH Web profile、credentials、tools、Skills、presets 和官方 Session store 为事实源。
- 对不支持的版本、认证或行为失败关闭，并给出不含 token/cookie/完整启动 URL 的诊断。

**Non-Goals:**

- 不支持 `0.1.0-rc.7/.8`、`0.1.1-rc.1`、任何 `0.1.2-alpha.*` 或未来 rc/stable；这些版本只有在后续独立 Gate 后才能加入支持集合。
- 首版不附着已运行的 Modern Web，也不接受外部 bootstrap URL；Modern 只使用 CH 自己启动的 exact rc.1 进程。
- 不扫描本机端口或发现任意位置的 DSH；只验证默认 3080 或显式配置的目标 endpoint。
- 不建立全仓 Harness semver 路由器、通用 Remote 框架或第二套公共 Harness 契约。
- 不用 ACP/SDK 替代缺失的 Web Remote 能力。
- 不导入用户已有的未映射 DSH Session，不持久化 transcript 副本。
- 不读取 DSH credential store 的 cookie secret、不关闭认证，也不把 token/cookie 写入日志、错误、Mapping Store 或 Renderer 契约。
- 不为凑提交数拆分实现，也不在协议事实未证明前提取共享抽象。

## Decisions

### 1. 一个公开 Adapter，两个完整内部实现

Host Runtime 继续只构造 `DeepSeekHarnessAdapter`。该类拥有一个可重试、成功后固定的 delegate selection promise，并将 `inspect/open/close` 委托给：

- `LegacyDeepSeekHarnessAdapter`：exact rc.2 Host ApiProxy wire；
- `ModernDeepSeekHarnessAdapter`：exact rc.1 Web Remote。

selection 失败不得永久缓存，显式 refresh 可以在安装、Host 启动或网络问题修复后重试；selection 成功后 Adapter 生命周期内不切换代际。`close()` 必须中止或等待正在进行的 selection，并只关闭实际创建的 delegate 和本次尝试拥有的进程。除 selector 外，不允许出现 `if (legacy)`/`if (modern)`。

现有 legacy adapter/session/history/host-client/permission/projection/model-catalog 及对应测试整体归 Legacy。以下内容只有在两代实现都证明语义相同时共享：

- DSH 可执行文件解析、Windows invocation 和版本输出解析；
- CH Model Ref 的稳定 provider/model 编解码；
- #71 的 reviewed Harness Command 白名单、参数解析与原生命令行构造。

不预建通用 DSH event/projector、generation registry 或 Remote transport 层。Modern 使用自己的 wire 类型和 schema，后续只抽取两边逐字同义的纯函数。

### 2. 支持矩阵是两个精确 release

最终支持声明固定为：

- Legacy：`0.1.1-rc.2`；
- Modern：`0.1.2-rc.1`。

本地可执行程序必须通过有界、无 shell 的 `dsh --version` 分类。任何其他已识别 release 返回 `unsupported`、`retryable: false`，消息先用中文、再用英文列出当前版本并建议升级到推荐的 `dsh-v0.1.2-rc.1`；包括 alpha.4/alpha.5 在内的相邻版本不因协议等价自动加入支持集合。旧 `host.describe.version === "0.0.1"` 只是 Host 占位值，不能证明 release。

为了保留既有 Legacy endpoint 行为，显式/默认 loopback endpoint 只有在完整 exact rc.2 envelope、schema 和全部必需 Legacy 能力探测通过时才能作为 rc.2 wire Host 附着；这不把未知 release 加入支持矩阵，也不能接受部分兼容。若本机能解析到已知不支持的 DSH，可执行版本诊断优先展示给用户。

Modern 不走上述行为附着：Legacy probe 收到 401/403 时，selector 只对同一个已校验目标 loopback root 发起一次无凭据、禁止重定向、有超时和逐字节上限的 `GET /`。仅当 status、headers 和 body 精确匹配 Modern DSH 的未认证根页面指纹时，Adapter 才返回 `authenticationRequired`、`retryable: false`、`stage: wire-handshake` 和 `diagnostic: externalModernWeb`；双语消息只说明该端点没有可供当前 codexhost 实例使用的凭据，并提示关闭该 DSH Web 后重新诊断，不推断它由用户、另一个 CH 还是遗留进程启动。其他 401/403 保留通用认证错误和 `HTTP_401`/`HTTP_403` diagnostic，不误报为 Modern DSH。首版不交换外部凭据，这样 token 的进程来源与 ChildProcess 所有权保持一致。selector 不扫描其他端口；其他端口上的 DSH 不影响 CH，除非用户将其显式配置为目标 endpoint。

#### alpha.5 协议等价证据

`dsh-v0.1.2-alpha.5` 精确指向 `db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5`。隔离 compiled artifact 的 lock SHA256 为 `EA51A6EAA1B695BC4490A2C6E206AF74B624501B4543C656F44822035015F288`；审计到的 214 个 DSH 包全部为 `0.1.2-alpha.5`，没有 nested DSH 或其他 DSH release 混入。

alpha.4→alpha.5 包含 6 个提交、280 个文件变更，其中 252 个是 package version，生产变化集中在 projection-cache/storage；CH 消费的启动、认证、HTTP Remote、Remote mux、Session Remote 和 Typert registry 发布产物除版本元数据外逐字节一致。使用当前 Modern Adapter 的 raw probe 分别连接 exact alpha.4 与 exact alpha.5 后，RPC/stream endpoint、参数/结果形状和 19 个关键 create/configuration 时序事件一致，结果为 `equivalent=true`。这些证据只用于建立 Modern 实现，不让两个 alpha 进入最终支持集合。

#### rc.1 发布证据

`dsh-v0.1.2-rc.1` 精确指向 `a66e4702047846cdaa10c66c9d3df3951f5ea70d`，提交时间为 2026-09-03T02:27:19+08:00。alpha.5→rc.1 只有 252 个 `package.json` 各一行版本替换，没有其他生产源码变化；源码 `pnpm-lock.yaml` SHA256 为 `E12083149A77F790D39B64D018B6B8745C6A7AA95777ECB73E0A2F5ED5FDD0D9`。隔离 npm compiled artifact 的 lock SHA256 为 `37AF94F193173F1E51BCA1A18A5F437649775953BE4A549466F913A869060ED1`，214/214 个 DSH 包均为 `0.1.2-rc.1`，没有 nested DSH release。

### 3. 选择与启动顺序保持无副作用

selector 按以下顺序工作：

1. 校验配置 endpoint 只使用无 userinfo、无 fragment 的 loopback HTTP(S)；query token 不能进入 Legacy probe。
2. 有界解析显式命令或本机 `dsh`，若存在则执行 `--version`；不执行 shell 字符串。
3. 对配置/默认 endpoint 执行只读 exact rc.2 probe；完整通过才选择 Legacy，不发送 Session 内容。
4. endpoint 若精确匹配未认证的 Modern Web 根页面指纹，则返回带 `externalModernWeb` 诊断的 `authenticationRequired`，不启动第二个共享同一 DSH home 的 Web；其他 401/403 只报告原始 HTTP 诊断。
5. endpoint 不可达时，exact rc.2 使用旧 `web` 启动并再次完成 Legacy probe。
6. endpoint 不可达时，exact rc.1 使用 Modern managed Web、`127.0.0.1` 与 `--port 0` 启动。
7. 没有受支持 executable 或 exact Legacy wire Host 时返回明确的 notInstalled/unsupported/unavailable。

selector 不杀死未知进程、不覆盖监听器、不把 Legacy probe 失败解释成 Modern 成功。每次失败的 selection 都清理自己创建的 ChildProcess、socket、timer 和监听器后才允许重试。

selector 只检查配置的 loopback endpoint，缺省为 `http://127.0.0.1:3080/`，不扫描其他本地端口。未通过 `CODEXHOST_DEEPSEEK_HARNESS_ENDPOINT` 明确配置的外部 DSH 不能被安全地发现或归属；端口扫描也不能证明进程身份、版本或 DSH home 所有权。

exact rc.2 的 compiled artifact Gate 证明旧 Web 会先开始监听，再完成 ApiProxy route 挂载。因此，只有在 CH 已验证 exact rc.2 executable 并启动、拥有该 ChildProcess 后，managed readiness loop 才能在同一 deadline 内重试临时 `HTTP 404`；预先存在 endpoint 的任何 404 仍是协议不兼容，必须失败关闭且不能触发竞争进程。

### 4. Modern Web 认证由 managed connection 独占

Modern connection 启动 `dsh web --no-open --host 127.0.0.1 --port 0`，持续消费 stdout/stderr，并只接受严格匹配的 `dsh web: <loopback URL>` readiness 行。URL 必须是该 ChildProcess 输出、根路径、恰好一个 `token` query、无 userinfo/fragment/其他 query。readiness 行只进入认证解析器，不能进入 stdout/stderr 诊断 tail。

连接以 `redirect: manual` GET 启动 URL，要求 `303`、`Location: /` 和一个同 authority 的合法 session cookie；只保留 origin 与目标 cookie pair。后续 HTTP/WS 只发送 origin + cookie，不重放 token。

安全约束：

- token、cookie、完整 launch URL 和含凭据的 header 不进入日志、异常 message/cause、测试快照或持久化；
- cookie 必须 Host-only、`Path=/`、HttpOnly、SameSite=Strict，拒绝 Domain、错误 authority、额外认证 cookie 和 malformed attributes；
- 401/403 映射 `authenticationRequired`，不回显响应中的凭据；
- Adapter 只停止自己启动且仍是同一 ChildProcess 的 Host；外部 Host 永不停止；
- readiness、认证或后续连接失败都执行有界 TERM→KILL teardown，并持续排空 stdout/stderr。

连接将同一 ChildProcess readiness 行验证的 bootstrap URL 只持久保留在 Adapter/Host 内存。公开 inspection 仅暴露无凭据的 `webUi.open=true` 能力；本地设置页点击专用 Host action 后，Host 通过 stdin 将 URL 交给通用 native loopback URL opener，再由操作系统打开浏览器，让 DSH 签发 HttpOnly cookie 并重定向到干净 `/`。DSH 的 exact token grammar 仍只属于 Adapter；Rust 只验证通用 HTTP(S)、loopback、显式端口、根路径及无 userinfo/fragment。Windows 使用系统 `ShellExecuteW` 的 `open` verb，不把 URL 交给会回退打开文件夹的 `explorer.exe`；launcher helper 同时移除继承的 `CODEXHOST_*` 与 `CODEX_CLI_PATH`。Renderer、RPC 响应、诊断和复制内容都不能获得 URL/token；操作系统 opener 的瞬时 URL 参数属于同机同用户可信平台交接，不承诺抵御已能观察同用户进程的本地恶意程序。Legacy、外部 DSH、远程 Host、已关闭进程或 stale action 不显示或拒绝该入口；失败动作立即清除 Renderer capability 并触发复检。只要同一 owned process 仍有效，重复点击可重复执行认证跳转；Adapter close 必须同步清除 URL，native opener 最迟 10 秒返回或被终止。

### 5. 所有 Modern 信任边界都有有限工作量

Modern 直接实现 rc.1 的最小 wire，不加载 DSH Client Cordis runtime：

- unary：`POST /api/<endpoint>`，body 为 `client-request`、随机 `rpcId`、同名 `method`、`payload.args`；严格解析同 rpcId 的 `server-response`；
- stream：带 cookie 的 `/api/remote.mux` WebSocket；发送 `open/cancel`，严格解析同 `streamId` 的 `item/error/end`。

实现必须为 readiness 行/累计 stdout、unary response body、WebSocket `maxPayload`、单 history record、每页记录数、最大分页次数和诊断 tail 定义有限常量。Modern 历史分页显式请求每页 200 条消息（不依赖 DSH 缺省 50）、最多 10,000 页，并复用 64,000 字符 Tool 输出投影上限；其他 byte cap 在代码中命名并由 exact-boundary/oversize 测试固定。超过上限返回 `protocolError`，不得截断 wire 后继续解释。

所有短操作有有界 startup/unary timeout；follow、control、$events、长命令和 interaction 使用 AbortSignal 生命周期。物理 WebSocket open 不等于 logical stream ready：follow 的 opening snapshot、control 的 baseline 与 `$events` 的 ready 首帧都必须在独立 deadline 内到达；超时必须 abort 并 exactly-once return 对应 iterator，不能留下后台 `next()` 或 stream。首版允许每个长期 logical stream 使用独立物理 WebSocket；只有性能证据出现后才复用物理 mux。

### 6. 完整历史使用 follow opening、固定 page cut 和 live buffer

`session/follow` 的 opening snapshot 是有界窗口，不是完整历史。create/resume 的 journal reader 必须：

1. 先打开 follow 并等待唯一 opening `snapshot`，验证 header id/cwd、cursor、records、hasMore 和 projections。
2. 在读取较早页之前开始缓冲该 follow 上所有 live `event` frame。
3. 以 opening `cursor` 作为不变的 inclusive `throughSeq`，从 opening 最早 seq 继续调用 `session/page`，按 `beforeSeq` 向前翻页直到 `hasMore=false`。
4. 无损展开 `event` 与 packed `chunks`，验证每个 record 覆盖的 seq、page 进展、无 partial overlap/重复/倒序/缺口，并拼出 `0..cursor` 的完整 journal。
5. 完整历史投影完成后，再按 `cursor + 1` 起始顺序应用 live buffer；重复 opening 范围的 frame 只能按证明过的 overlap 规则去重。

Snapshot、Native Turn Ref 和 Checkpoint 来自 DSH `turn/start`/`turn/end` 的稳定 turn/seq。已识别但不产生 CH 输出的 Modern core/profile event 仍需最小 schema 校验；未知 event 只有带 `ignorable: true` 才可忽略，未知 required event fault。

follow 没有 resume cursor。物理断线后必须打开新 follow，取得新 snapshot/page cut，并与最后已提交 seq 对账：可证明连续时替换/补齐，无法证明时 fault，不伪造或静默重置。

### 7. `session/control` 是实时 projection 的唯一 readback

Modern connection 维护一个 Adapter 级 `session/control` stream，首帧必须是完整 `baseline`，之后只接受 `projection`、`queue` 和 `jobs` frame。CH 仅保留 loaded/mapped Session 的 projection；其他 DSH Session 的 baseline 行立即丢弃，不进入列表、日志或持久化。

每个 projection 保存 `{value, seq}`。Session opening follow snapshot 与 control baseline 按 seq 合并，较高 watermark 胜出。重连后的 control baseline 整体替换当前 generation，再与每个已加载 Session 的 journal seq 对账。

Model/Thinking 和 Permission 选择流程必须：

1. 捕获调用前 projection watermark；
2. 调用 `session/selectModel` 或 reviewed `/permission` command；
3. 等待 seq 更高且精确匹配请求的 `modelSelection`/`permissions` projection；
4. 只有确认后发布 `session.state.changed`，不使用 unary 成功或 command text 乐观更新。

`settings/describe` 的 `permission` namespace 只用于 inspect catalog/default；Session projection 的 options/currentValue 是运行时事实，两者必须对账。缺失、malformed、陈旧或互相矛盾时失败关闭。

普通 Permission 选择始终使用上述动态 catalog，不固化 preset ID。唯一例外是 exact `0.1.2-rc.1` 的 delegation bridge：`unattended-full-access` 映射到该 release 内置语义已确认的 `danger-full-access`，但只有动态 catalog 同时广告该 ID 时才能执行。命令成功和 control projection 仍不足以证明 delegation；首次完整 journal 还必须以后验方式确认最近的 `permission/preset=danger-full-access`、`sandbox/mode=danger-full-access` 与 `approval/policy=never` 三项事实，否则 open 失败关闭。显式 Permission Mode 与 `unattended-full-access` 不能组合。

### 8. Turn admission 由 requestId 与原生 journal 关联

create 使用 `session/create`；resume 只对 Mapping Store 给出的 Native Session ID 打开 journal，不扫描/import 其他 Session。所有 `session/create|selectModel|prompt|cancel|fork|page|follow` 调用都保留 Modern rc.1 Typert 的单一对象参数，wire args 必须是 exact `{ request: { ... } }`，不得把业务字段摊平。prompt 使用 client-minted requestId、`mode=queue` 和有序 text content。

`session/prompt` 成功只表示进入 Agent inbox，不直接发布 Turn started。由于 `turn/start` 可先于携带 `source.rpcId` 的 `user/message`：

- CH 为每个已接受 Host Turn 保存唯一 pending requestId；
- native `turn/start` 先建立事件 buffer；
- 后续 `user/message.source.rpcId` 精确匹配时才绑定该 Host Turn，并按 native 顺序投影已缓冲事件；
- 同一 claim 的首批消息可能包含多个 `user/message`；任一 source 匹配 pending requestId 时绑定，不能因更早的 foreign/no-rpcId 消息提前分类；首批 source 可证明全部不匹配或直到 `turn/end` 仍未匹配时，才按 autonomous Turn 投影；`step/start` 早于携带 rpcId 的 `user/message`，不能作为 autonomous 分类截止点；
- 一个 requestId/native turn 只能绑定一次，迟到 prompt response、重复 event 或 cancel 不得创建第二个 Turn。

prompt 没有 requestId 幂等去重；transport 结果不确定时不得自动重试，后续 durable user source 仍按同一 pending requestId 关联。cancel 调用 `session/cancel`，只接受 acknowledged response；idle Session 也可能 acknowledged，Host Turn 仍只能从 authoritative `turn/end` 完成一次。readSnapshot、restart resume、incomplete Turn 恢复、prompt 与 autonomous Turn 竞态必须共用同一关联规则。

Modern rc.1 的 `agent/pre-step` 可以在 `turn/start` 后拒绝、清空或改写已 claim 的消息，使已接受 requestId 永远不出现在 `user/message`。因此，inbox admission 只能证明 unary outcome，不能清除“accepted 但未绑定”的独立 correlation deadline；deadline 到期时 CH 必须将该 Host Turn exactly-once 失败并 fault Session，不能重发 prompt、把无证据的 native Turn 绑定给它或永久保持 `sessionBusy`。

Usage 从 native assistant/message/usage 事实规范化，并保持可选 telemetry：malformed Usage 不得改变本来有效的 Turn outcome，但 required core event malformed 仍 fault。

DSH 的 `reasoning-delta` 是 provisional 内容，最终 `assistant/message` 中的 reasoning block 来自 authoritative `block-end`，可能删除尾部换行、改写中段或变为空。Host Item 协议只允许 append 并要求完成快照严格等于已 append 前缀，因此 Modern Adapter 不把 provisional reasoning 提交给 Host；它先纯校验同一完整消息的正文前缀，再一次 append 并 complete 非空权威 reasoning，避免无效消息被部分提交。普通 assistant text 始终实时流式并保留严格 prefix 校验，surface replacement copy 不进入人类 transcript 或 Usage。该规则同时用于实时 Turn、多 Turn、历史恢复和 follow replacement，避免直接覆写本地 Item 后在 Protocol Core 再次触发 invariant。由于权威 reasoning 只有在正文已经流式后才可用，live UI 可在正文之后显示 Reasoning；`readSnapshot()` 仍按 DSH 原生 message content 保留 Reasoning→Agent 顺序。这是正文实时、append-only Host 和可修订 reasoning 三项约束下的明确取舍，不修改 Protocol Core。

### 9. #71 命令跨代保留，原生 wire 各自拥有

共享命令层只知道 CH 命令 ID、参数和最终原生命令行。Legacy/Modern 各自实现 `list/execute`：

- Modern 使用 `commands/list({ agentId: sessionId })`；
- Modern 使用 `commands/execute({ agentId, line, images: [] })`；
- 仍只发布 reviewed `compact`、`goal`、`plan`；
- catalog、result、commandId 和 sourceEventSeq 严格校验；
- command 发现跨越 await 后仍由 Host Runtime 的 active Turn 二次检查拒绝竞态；
- permission 命令只供内部 Permission control，反馈、模型和未知未来命令不透传。

### 10. `$events` 尊重多客户端 waterfall 与 generation replacement

Modern connection 维护一个 Adapter 级 `$events` stream，首项必须是 exact `{ type: "ready", clientId, host: { home } }`，其中 clientId 非空且 host.home 为字符串。Gateway 会把同一个 pending waterfall 发给所有 Client，因此 CH 只 claim loaded Modern Session 的合法 `approval/request` 和 `user-questions/request`：

- 未加载/未映射 agentId、未知事件名或 CH 不负责的合法请求立即以 `$events/result` 返回 `outcome: next`，把回答权留给其他 Client/DSH listener；
- 已知事件但 payload malformed 时可返回 rejected，并 fault 对应 loaded Session；
- 不得自动批准、发明答案或因 CH 不负责而全局取消 DSH waterfall。

每个本地 interaction 以 Remote `eventId` 为身份，并绑定当前 generation 的 `clientId`。物理断线时暂时保留 pending interaction；replacement `$events` 会以同 eventId 重放，CH 必须重绑定新 clientId，而不是创建第二个 Host interaction。旧 clientId 的迟到结果、重复 replay 和随后 cancel 均幂等。

Host 响应通过 `$events/result` 提交一次 exact `{clientId,eventId,outcome}`。显式 Remote `cancel`、成功 settlement 或最终不可恢复 Session fault 才关闭本地 interaction。Session/Adapter 主动 detach 前先对仍有当前 delivery 的请求发送 `next`；若意外断线且无法恢复，先 best-effort `session/cancel` 使 DSH 请求信号收敛，再 fault Session。

`unattended-full-access` 只通过决策 7 所述、同时经过动态 catalog、control projection 与 journal 三事实确认的 exact rc.1 Permission preset 生效，不能用 waterfall 临时放宽策略。

### 11. Modern Fork 使用完整原生前缀并做后验验证

Modern Fork 先用完整 journal reader验证 sourceRef、同 cwd 和 checkpoint 的 `turn/end` seq，再调用 `session/fork({ request: { sessionId, atSeq } })`。DSH 选择第一个 `seq >= atSeq` 的 `turn/end`，并保留该完成 Turn 之后、下一 `turn/start` 之前的配置事件；若 atSeq 位于最后一个 `turn/end` 之后但仍未越过 journal 尾部，DSH 返回 fork unavailable 而不会回退，预期前缀必须按这一原生语义计算。

Fork 返回后打开 child follow/page/control，并验证：

- child ID 与 source 不同；
- header parentSession、cwd、seedLength 合法；
- inherited raw prefix、`session/end-seed` 和可见 Turn checkpoint 精确匹配；
- child Native refs 全部使用 child Session ID。

后验失败关闭且不自动重试；DSH 没有可靠 delete/idempotency 时允许留下官方 orphan，并在诊断中只报告稳定错误，不泄露路径或内容。

### 12. 错误、诊断和重试按所有权分层

- executable 缺失 → `notInstalled`；
- 不是 `0.1.1-rc.2`/`0.1.2-rc.1` → `unsupported`、非重试，并以中英文提示升级到 `dsh-v0.1.2-rc.1`；
- 配置/默认目标 endpoint 精确匹配未认证根页面指纹 → `authenticationRequired`、`externalModernWeb`、`wire-handshake` 和双语关闭/重试提示，不回显凭据；其他 401/403 → 通用 `authenticationRequired` 与 `HTTP_401`/`HTTP_403`；
- malformed/oversized unary、stream、journal、projection → `protocolError`；
- Remote 业务错误按稳定 code 映射 sessionBusy/sessionNotFound/checkpointNotFound/unsupported/invalidRequest/nativeFailure；
- owned child exit → `processExited`；
- transient startup/connection fault 可在显式 refresh 后重试；版本、schema 和认证配置错误不自动重试。

诊断只保留 stage、duration、稳定 code 和 `sanitizeDiagnosticTail` 处理后的 stderr tail。readiness stdout、token、cookie、Cookie/Set-Cookie header 和完整 launch URL永不进入诊断。

### 13. 测试以行为与 exact artifact 为证据

Hermetic tests：

- selector：exact rc.2、exact rc.1、alpha.4/alpha.5 与所有其他版本、Legacy wire probe、Modern external refusal、并发 inspect/open、失败后 refresh、close race；
- auth/process：readiness grammar、303/cookie/origin、secret canary、stdout/stderr backpressure、所有超限、process exit 与 bounded teardown；
- unary/mux：envelope、RPC ID、Remote error、timeout、cancel、错 streamId、乱序和 oversized frame；
- journal：follow-first、固定 throughSeq paging、packed chunks、live buffer、overlap/gap、10,000-page work budget、reconnect repair/fault；
- control：baseline/update、watermark、stale update、external change、replacement baseline；
- Turn：requestId 先后顺序、prompt/autonomous 竞态、resume incomplete、cancel、authoritative reasoning 修订和 exactly-once terminal；
- `$events`：多 Client next、claim、replacement replay、旧 clientId、cancel、close/fault；
- Modern Adapter：inspect/create/resume、Model/Thinking、Permission、commands、Usage、Fork；
- Legacy 全量既有测试原样通过；共享 command/model-ref 对两代执行同一行为表。

真实 Gate：

- 只在隔离安装、独立 DSH_HOME/port 上运行 exact `0.1.1-rc.2` Legacy 最小完整矩阵；未 Gate 的旧 release 不加入支持集合；
- exact `0.1.2-rc.1` 运行 compiled artifact 的 version、managed auth、inspect、create、长历史、多 Turn/Reasoning、autonomous Turn、Tool/Diff/Usage、restart resume、cancel、Model/Thinking、Permission、Question/Approval、多 Client/reconnect、commands、Web action/URL handoff 和同 cwd Fork；`ShellExecuteW` 修复后的 Windows 默认浏览器与已认证 DSH Web 可见结果已由用户实测确认；
- exact alpha.4/alpha.5 的既有 Gate 仅作为 Modern 协议演进证据，不宣称当前构建支持它们；
- 使用 keyless mock/replay profile 覆盖协议，不要求真实模型凭据；
- Windows 本地 Gate 必须通过；Linux/macOS 只有实际 CI/机器运行后才能声明，不以推断代替；
- TypeScript build/typecheck、focused tests、lint、format、OpenSpec strict validation、`git diff --check` 和 release-package smoke 通过；
- 未运行的实机能力不得在 PR 中宣称通过。

2026-09-03 Windows Gate 使用 lock SHA256 为 `EA51A6EAA1B695BC4490A2C6E206AF74B624501B4543C656F44822035015F288` 的 exact alpha.5 artifact，通过公开 `DeepSeekHarnessAdapter` 验证了 managed auth、inspect/create、默认与备用 Model/Thinking/Permission、105 Turn/Usage、4 次真实分页、restart resume、105 Turn Fork、compact/goal/plan、cancel 后继续、Tool/Diff、Approval、Question、两个额外 `$events` Client、pending event carrier replacement、autonomous Turn 及每组 PID/port teardown。exact alpha.4 artifact 以 lock `3F9B1CFA141E55748198BA1027854BAD9584E79C2DCFA85679425467888829EF` 回归 managed auth、inspect/create、默认与备用配置、105 Turn/Usage、4 次真实分页、restart resume、105 Turn Fork、命令、cancel、Tool/Diff、Question/Approval、两个额外 `$events` Client、pending event carrier replacement、autonomous Turn 与 teardown；exact rc.2 Legacy Gate 通过 10/10 managed inspect/close、PID 退出和端口释放。wire oversize、secret canary 与 follow/control 物理断线等故障注入仍由聚焦测试覆盖，不误写为本轮 compiled artifact 实测。

## Risks / Trade-offs

- [rc.1 Remote 是 Web BFF 而非第三方稳定协议] → exact pin、严格 schema、compiled artifact Gate；未来版本独立升级。
- [已运行 Modern 无可信版本/凭据交接] → 首版拒绝附着；等待 DSH 提供正式 version/auth handoff 后再扩展。
- [两套完整 Adapter 有重复] → 重复只存在原生边界；比共享错误抽象和散落版本分支更容易验证。
- [每 stream 一个物理 WebSocket] → 首版优先正确性；只有测得资源问题后再复用 mux。
- [`session/control` 暴露 Host-wide baseline] → 仅保留 loaded/mapped Session 行，其余立即丢弃。
- [Fork 后验失败可能留下 orphan] → 失败关闭且不自动重试；等待 DSH delete/idempotency 能力。
- [用户 profile 扩展事件] → 已知 required event 明确识别，未知 ignorable event 忽略，未知 required event fault。
- [最终 Reasoning 晚于已流式正文可见] → 不发布 provisional 内容；在 change spec 与 PR 中明确 live ordering 取舍，历史仍保留原生顺序。
- [浏览器认证 URL 必须交给本机平台] → 第一跳使用 stdin，持久层/Renderer/诊断不含 token；Windows 以清理后的 helper 环境调用系统 `ShellExecuteW`，平台交接属于同用户可信边界并有 10 秒 Host deadline。

## Migration Plan

无 Mapping Store schema 迁移。现有 DeepSeek Thread 的 Native Session ID 保持不变；当前运行时选择一个代际后用该 DSH Host 尝试 exact ID。DSH 自身拒绝旧格式或缺失 Session 时，CH 返回明确错误而不读取 JSONL或删除数据。

Legacy 回滚只需恢复原入口；Modern 创建的官方 DSH Session 仍保留在 DSH store，旧 CH 会明确无法打开而不会删除。首版不持久化 generation 到 NativeSessionRef，也不把 `formatVersion` 误当 DSH 协议版本。

开发过程中可以产生 `fixup!` 提交；创建 Draft PR 前在不损害 #71 审查来源的前提下 autosquash。若 Modern exact artifact 实测推翻某项 API 假设，必须同步更新 design、spec、任务和测试证据。

## Final Commit Plan

当前 #71 四个提交与本设计提交保持逻辑来源。最终整理为以下 20 个可独立评审的逻辑提交，不为满足数字合并或拆散行为；每个行为提交同时携带自己的测试：

1. `feat: 扩展 DeepSeek Harness 文本命令适配`（已有）
2. `feat: 路由 Harness 文本命令提交`（已有，含竞态修复）
3. `feat: 添加 Harness 文本命令编辑器入口`（已有）
4. `docs: 更新 DeepSeek Harness 命令规范`（已有）
5. `docs: 设计 DeepSeek Harness 协议代际适配`
6. `refactor(deepseek): 共享跨代模型与命令语义`
7. `feat: 扩展 Harness 托管 Web 能力契约`
8. `feat(deepseek): 建立 Modern Web Remote 传输`
9. `feat(deepseek): 读取 Modern Journal 与控制状态`
10. `feat(deepseek): 接入 Modern 配置与原生命令`
11. `feat(deepseek): 投影 Modern 会话历史`
12. `feat(deepseek): 建立 Modern 人机交互网关`
13. `feat(deepseek): 投影 Modern Turn 生命周期`
14. `feat(deepseek): 装配 Modern Session 运行时`
15. `feat(deepseek): 识别受支持的 DSH 协议代际`
16. `refactor(deepseek): 隔离 Legacy Host Adapter`（99～100% rename，行为不变）
17. `feat(deepseek): 选择受支持的 DSH 协议代际`
18. `feat: 添加原生 loopback URL 打开入口`
19. `feat: 路由 Harness 托管 Web 打开动作`
20. `feat: 在设置页打开托管 Harness Web`
