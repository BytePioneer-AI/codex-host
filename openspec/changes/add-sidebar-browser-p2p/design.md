# Design

动机与范围见 [proposal](proposal.md)，可观察行为见 [web-direct-connection](specs/web-direct-connection/spec.md)。

## Context

- 侧栏浏览器每个标签一条 `/api/sidebar-browser?tab=<key>` WebSocket，承载 JSON 控制消息（导航、输入、`ack`）与二进制帧。连接已过 `auth.admitUpgrade`（登录凭据登记，撤销时关闭）和同源校验。
- 帧格式：格式字节、CSS 尺寸、`sequence`（float64，按标签递增）、几何代次、图像。`ack` 确认“已呈现的最新帧及之前所有帧”。每个查看者最多 2 帧、合计约 512 KiB 在途，窗口满时只保留最新待发帧；`SidebarBrowserDelivery` 按确认字节与耗时估算交付速率，慢链路且最近 400 ms 有输入时临时降为 1 倍输出。
- 附件上传是 `POST /api/session/uploadFileBinary`（`application/octet-stream`，查询参数带 `sessionId`）；右侧栏预览是 DSH Remote 的单次 JSON 请求（`dsh.handleApiRequest`），聊天图片是 `GET /api/file?path=`，只返回栅格图片。
- 入口差异：Relay、Tailscale Serve/Funnel、frp + nginx 的 TLS 在电脑上终止；Cloudflare Tunnel 与外部 nginx 的 TLS 在入口终止（见 `docs/product/web-remote-access.md`「谁能看到内容」）。信令经过的就是页面与登录所用的同一条 TLS，直连的可信程度因此与页面本身相同，不高于所用入口。

## Decisions

### D1. 每个页面一个直连，信令走独立的信令连接

上传与预览在没有打开侧栏浏览器标签时也会发生，所以直连按**页面**建立，而不是按标签。页面在 `/api/sidebar-browser` 上另开一条不带 `tab` 参数的信令连接（同一路径、同一认证与同源校验，不创建标签、不启动服务器浏览器），信令与直连生命周期一致：信令连接关闭即关闭直连。

**按需建立。** 页面加载时不建立信令、不查询 STUN。只有出现可见的远程浏览器标签时才启动；收起侧栏（祖先带 `inert`）、关闭或切走标签即视为不可见，服务端立即停止向该查看者推帧。最后一个可见标签消失 30 秒后关闭直连、信令与心跳，30 秒内重新可见则沿用原连接。第 2、3 组（上传、预览）实现时再决定它们是否也作为启动条件。

放弃：在每个标签连接上各自协商（多标签时多个直连，且无标签时上传与预览无法直连）；改走 `/api/remote.mux`（与已定的信令路径不符）。

直连对用户完全无感：界面不显示直连状态、开关或重试入口，失败与回退不产生提示。所有判断（是否尝试、冷却、回退）都在客户端与电脑内部完成。

### D2. 信令消息

全部是信令连接上的 JSON 文本消息，`attempt` 为客户端递增的**协商代次**（每次完整协商或 ICE restart 各占一个新值），电脑只处理当前代次，旧代次消息丢弃。

| 方向 | 消息 | 作用 |
| --- | --- | --- |
| 电脑 → 手机 | `direct-hello { peer, target, boot, iceServers, offered }` | 连接后立即下发。`peer` 为随机且只属于本凭据的直连会话 ID；`target` 为电脑上持久的随机 ID（存于 Web 数据目录）；`boot` 为本次 Web 启动的随机 ID；`iceServers` 为内置或覆盖后的 STUN 列表；`offered` 按 D13 由信令连接的升级请求判定，为 `false` 时客户端不查询 STUN、不尝试 |
| 手机 → 电脑 | `direct-offer { attempt, sdp, restart }` | 手机为发起方，SDP 中带手机的 DTLS 指纹。`restart: true` 表示在当前 `RTCPeerConnection` 上做 ICE restart（D7），电脑保留原连接重新协商；为 `false` 时电脑关闭旧连接并新建 |
| 电脑 → 手机 | `direct-answer { attempt, sdp }` | 带电脑的 DTLS 指纹 |
| 双向 | `direct-candidate { attempt, candidate \| null }` | Trickle ICE，每收集到一个候选立即发送；`null` 只表示收集结束，任何一方都不等待它 |
| 电脑 → 手机 | `direct-ready { attempt }` | 电脑确认 DTLS 已用信令中的指纹完成、控制通道已打开并与本凭据绑定。客户端只在收到它后才路由流量 |
| 双向 | `direct-close { attempt, reason }` | 主动结束：超时、被新尝试替换、凭据撤销、对端关闭 |
| 手机 → 电脑 | `direct-skipped { reason }` | 因冷却或浏览器不支持而未尝试，只用于观测 |

`sdp` 与 `candidate` 只经此连接传递；电脑不在信令之外接受任何对端。一个信令连接同时只有一个尝试：新的完整协商 `direct-offer` 关闭旧连接；`restart` offer 只让旧代次的消息失效，连接本身保留。

**必须 trickle ICE。** 电脑应用 offer 后立即发 `direct-answer`，之后每收集到一个本地候选就发一条 `direct-candidate`；手机同样边收集边发。任何一方都不得等待候选收集完成再发 SDP 或开始连通检查：werift 电脑端收集完成约需 5 秒（个别 STUN 无响应时更久），而原型同机首连为 0.35–1 秒，DataChannel 常在收集完成前就已打开。

**werift 应答方的检查起点。** werift 0.28 作为应答方会先发 answer、逐个 trickle 候选，但要等主套接字上的 STUN 查询全部返回或超时后才开始连通检查；默认超时下，一个不响应的 STUN 会把检查推迟约 5 秒。电脑端因此设置 `iceStunGatherTimeout` 为 1.5 秒：六个 STUN 并行，正常网络下最快的一个通常在几百毫秒内返回，足以得到反射候选；慢于 1.5 秒的 STUN 不再拖住检查。不修改、不 fork werift。这段时间画面一直走现有连接，用户无感。

**超时与失败判定。** 从发出 offer 起 10 秒内未收到 `direct-ready` 即为一次失败；该值大于 werift 收集完成的约 5 秒，留出跨网 STUN 反射候选的检查时间。D7 的 ICE restart 与重新协商各自同样以 10 秒为限。

**代次隔离。** 每个 `RTCPeerConnection` 与当前 `attempt` 绑定，ICE restart 时把绑定更新为新代次。两端的所有回调（状态变化、候选、通道打开与关闭、收到的帧片与确认）先核对所属 `attempt` 仍是当前代次，否则丢弃，不触发回退、失败计数或写入。帧片头部带 `attempt`，客户端丢弃旧代次的片；电脑只处理当前代次通道上的确认。原型中主动关闭旧连接产生的 SCTP abort 曾干扰新连接，代次隔离后重建全部通过。

### D3. DataChannel 划分

- `control`：协商时创建，可靠有序；电脑以它的打开作为 `direct-ready` 的前提，并承载应用层心跳：两端每秒发一次 `ping`，3 秒内未从 `control` 收到任何消息即视为断开，按 D4 立即回退。心跳是必需的，因为旧版 iOS Safari 关闭时可能不发出通道或连接的关闭事件。
- `frames`：每个使用直连的标签一条，可靠有序，标签名带标签 key。
- 请求通道：每个上传或预览请求一条，可靠有序，请求结束即关闭；关闭通道即取消请求。

**分片与背压（所有通道通用）。** 单条消息（含头部）不超过 16 KiB，且不超过协商的 `maxMessageSize`；对端 SDP 未声明时按 64 KiB 上限处理（原型中 Chrome/WebKit 与 werift 协商为 64 KiB）。发送端在下一片会让通道 `bufferedAmount` 超过 128 KiB 时暂停，降到 64 KiB 再继续：把 werift 通道的 `bufferedAmountLowThreshold` 设为 64 KiB 并订阅其 `bufferedAmountLow` 事件，不轮询。`bufferedAmount` 为零只表示已交给 SCTP，不代表对端已收到，接收确认仍以应用层确认为准。

画面与文件共用一条 SCTP 关联。为不让文件挡住画面，请求通道只在所有 `frames` 通道的 `bufferedAmount` 不高于 64 KiB 时发送下一片。

### D4. 画面经直连：复用帧序号与累计确认

- **标签绑定**：标签连接上新增客户端消息 `transport { peer }`。电脑校验该标签连接与 `peer` 会话属于同一凭据，且该标签的 `frames` 通道已打开，然后回复 `transport { via: "direct", from: <sequence> }` 并改经通道发送；不满足时回复 `transport { via: "socket" }`。导航、输入与可编辑区域消息始终留在标签连接。
- **分片**：每帧沿用现有二进制帧（含 `sequence` 与几何代次），按 D3 切片。片头：连接代次 `attempt`、`sequence`、片在帧内的偏移、帧总长度。可靠有序通道保证同一帧的片按序到达，客户端收齐后按现有帧解码与呈现。客户端拒绝偏移越界、总长度与首片不一致或超过帧长度上限的片，并按断开回退。
- **确认**：客户端在呈现后经 `frames` 通道回 `ack { sequence }`，语义不变（累计确认）。电脑按查看者维护一个在途集合，不区分帧经哪条路径发出；累计确认对两条路径的在途帧同样生效。
- **不倒退**：客户端只呈现序号大于已呈现序号的帧。切换瞬间两条路径都可能有在途帧，较旧的到达后直接丢弃并照常确认。
- **流控**：保留“最多 2 帧、约 512 KiB 在途，绘制后累计确认，窗口满只保留最新待发帧、不追加队列”；把“socket 待发字节”替换为当前路径的待发字节，直连上再叠加 D3 的 128 / 64 KiB 通道背压。切换路径时重置该查看者的交付速率样本，避免用旧路径的速率决定 2 倍 / 1 倍。
- **回退（立即）**：任一侧观察到以下事件即刻回退，不等待超时：`frames` 或 `control` 通道 `close` / `error`，`RTCPeerConnection` 的 `connectionState` 或 `iceConnectionState` 变为 `disconnected`、`failed`、`closed`，D3 的心跳超时。电脑把该查看者切回标签连接，清空经直连的在途记录，经标签连接补发当前画面，并发 `transport { via: "socket" }`；客户端观察到事件时同样立即在标签连接上发 `transport` 请求回退，两侧谁先发现都生效。`disconnected` 可能随后自行恢复，此时按 D7 的快速重连切回，而不是等它恢复再回退。
- **静默卡死兜底**：没有上述事件、心跳也正常，但经直连的在途帧 3 秒未获确认时，按断开处理。这只用于检测 `frames` 通道单独卡住，不是常规回退路径；原型同机帧确认 P95 为 10–21 ms。

### D5. 上传与预览的路由规则

客户端只有一个路由判断：**直连已就绪（收到 `direct-ready` 且未在关闭中）且请求属于白名单，才走直连，否则走 HTTP。** 判断在请求开始时做一次，请求进行中不迁移。

| 请求 | 直连 | 说明 |
| --- | --- | --- |
| 附件上传 `uploadFileBinary` | 是 | 请求头为原 HTTP 查询参数与长度，随后分片正文，结束标记 |
| 右侧栏预览：文本 / 代码读取、图片与 PDF 字节读取 | 是 | 请求体为原 DSH JSON 信封；电脑只放行白名单中的只读方法，其他方法返回“不支持”，客户端改走 HTTP |
| 聊天图片 `GET /api/file` | 是 | 仍只返回栅格图片 |
| 音视频、HTML 预览，Office 转换，表格，文件下载，其他 API | 否 | 始终 HTTP |

电脑端以该直连绑定的凭据调用与 HTTP 相同的处理逻辑，返回相同的状态、类型与正文；不在直连层复制鉴权或文件规则。

失败处理：D4 中的断开事件同样立即作用于请求通道。在收到响应头之前通道失败或直连断开，客户端立即对同一请求改经 HTTP 重发一次（预览为只读；上传在电脑端未收到结束标记即丢弃，不会留下文件）。响应头之后失败按现有 HTTP 中断处理（上传走现有失败恢复与有限重试）。“上传已在电脑完成但结果没送回”与 HTTP 连接中断时的歧义相同，不另做去重。

### D6. 退避状态存储

- 位置：手机浏览器 `localStorage` 的单个键 `codexhost.direct.v1`，所有读写包在 `try/catch` 中，不可用时退回页面内存。
- 结构：`{ [target]: { boot, networks: { [network]: { failures, until } } } }`；每个 `target` 最多保留最近 32 个网络，超出按最早淘汰。
- `network`：本次正式协商用的 `RTCPeerConnection` 收到的**第一个** STUN 反射候选的公网地址（IPv4 取完整地址，IPv6 取 /64 前缀）取哈希；2 秒内没有反射候选或收集已结束仍没有时为固定值 `none`。不另建探测连接：客户端创建连接并 `setLocalDescription` 后先缓存 offer 与本地候选，拿到 `network` 即判断冷却；处于冷却则关闭该连接，不发 offer，只发 `direct-skipped`；否则发出 offer 与已缓存候选，之后继续逐个 trickle。只等第一个反射候选，不等收集完成。同一网络偶尔得到不同出口地址时只会多尝试，不影响功能。
- 冷却：第 n 次连续失败后为 `[10 min, 1 h, 6 h, 24 h][min(n, 4) - 1]`。
- 重置只有两种：`network` 不同即为另一条记录（换网络）；`direct-hello.boot` 与记录中的 `boot` 不同时清空该 `target`（电脑 Web 重启）。没有手动重试。成功收到 `direct-ready` 时删除当前记录。
- 重新尝试的时机：页面加载、回到前台、`online` 事件、网络类型变化（浏览器支持时）各触发一次候选收集与判断。

### D7. 断开后的快速重连

直连在 `direct-ready` 之后断开时，流量先按 D4 / D5 立即回到现有连接；随后在后台先在同一 `RTCPeerConnection` 上以新 `attempt` 发 `restart: true` 的 offer 做一次 ICE restart（连接已关闭时跳过这一步），失败则以新 `attempt` 完整重新协商一次，任一次就绪即按 D4 切回直连。两次都未在各自超时内就绪才记一次失败。重连期间流量始终走现有连接。`document.visibilityState` 为 `hidden` 期间发生的断开不计失败，回到前台后按 D6 重新判断。

### D8. 与令牌撤销的联动

- 直连会话按凭据登记到与 WebSocket 相同的已认证连接集合（`CredentialConnections`），`accessTokens.onRevoked` → `connections.revoke(id)` 时与信令连接一起关闭。退出登录只清除该浏览器的 Cookie、不撤销凭据；页面随即进入登录页，信令连接随页面关闭，直连按 D1 随之关闭，客户端也在退出前主动关闭直连。
- 关闭顺序：先标记会话失效（之后不再向任何通道写入），再关闭通道与 `RTCPeerConnection`，最后关闭信令连接。异步回调中检查失效标记，避免撤销后的迟到写入。
- 标签的 `transport` 请求与请求通道在处理前都重新检查会话仍有效且凭据一致。

### D9. 内置 STUN 与开发覆盖

- 默认列表位于浏览器安全的共享契约中，电脑经 `direct-hello` 下发给手机，两端使用同一份。
- 开发覆盖：环境变量 `CODEXHOST_WEB_STUN_URLS`（逗号分隔）。只接受 `stun:` 地址，含其他协议时 Web 启动失败；设为空字符串表示关闭直连（`offered` 一律为 `false`，见 D13）。不写入用户文档、设置或启动参数。
- 两端 `iceServers` 只含 STUN，不存在中继候选；观测中候选对类型为 `relay` 视为缺陷。

### D10. 观测

电脑在 Web 日志输出结构化行，沿用上传与会话列表计时日志的方式：

- 每次尝试一行 `[direct] attempt`：`outcome`（`ready` / `failed` / `closed` / `skipped`）、`reason`、`readyMs`（offer 到 ready）、`pair`（两端候选类型，如 `srflx/host`）、`restart`（是否为快速重连）。
- 每个直连会话结束一行 `[direct] session`：持续时间；画面、上传、预览各自经直连与经现有连接的字节数与请求数；回退次数与原因。
- 直连占比 = `ready` / (`ready` + `failed` + `skipped`)，画面直连占比 = 经直连画面字节 / 画面总字节；建连时间取 `readyMs` 分布。
- 归属：尝试结果按直连会话记；画面字节只有在标签以 `transport { peer }` 绑定后才能归到会话，从未绑定的页面（建连失败、冷却、未提供直连）无法归属，因此画面直连占比按 Web 进程汇总两条路径的字节，定期输出一行 `[direct] frames`，不改客户端协议。
- 不记录 IP、候选地址、`network` 哈希或内容。

### D11. 电脑端 WebRTC 实现：`werift` 0.28.x

电脑端在 Web 的 Node 进程内使用 `werift`（锁定 0.28.x），随现有 Web bundle 由 esbuild 打包，无原生依赖。理由：

- 唯一满足“六个 STUN 并行查询”的候选：0.27 起逐 URL 并行查询，本机六个模拟 STUN 均收到请求。
- 支持 ICE restart（`restartIce()` 与 `iceRestart` 协商），D7 的快速重连可先在原连接上重启。
- 纯 TypeScript，macOS / Windows / Linux 的 x64 与 arm64 共用同一 bundle，不需要按平台分发、签名与验证原生 addon；单用途探针 bundle 约 1.3 MB。上传与预览直连不依赖服务器浏览器是否启动。
- 本机实测性能足够：30 fps × 160 KiB 合成帧时 Node 约占 20% 单核；不限速时 25–28 MB/s。Chrome 与 WebKit 20/20 首连、重建与 ping/pong 成功，错误 DTLS 指纹被拒绝。

证据：`research-p2p-stack-codex.md`（选型调研）与 `p2p-spike-results.md`（原型实测）。

已考虑的方案：

- `node-datachannel`（libdatachannel）：建连与重建更快，但官方预编译的 libjuice 后端每个 `RTCPeerConnection` 只随机使用一个 STUN；另需按六个发行目标分发原生 addon，现有预构建的 glibc 与 macOS 最低版本高于发行基线。
- 复用服务器浏览器（Chromium 隐藏页）：上传与预览直连会依赖机器上有可启动的浏览器，并承担其崩溃、退出与桥接生命周期；保留作互通对照。
- Pion（Go 子进程）：能力满足，但需新增 Go 构建、六目标产物与进程间二进制传输管理；作为以后需要固定 UDP 端口或隔离传输 CPU 时的备选。
- `@roamhq/wrtc`：基于较旧的 libwebrtc（M106），缺 Windows arm64，Linux 包要求较新的 glibc。

### D12. 不做 UPnP / NAT-PMP / PCP

首版是非目标：电脑不请求路由器端口映射，只用普通 ICE + 内置 STUN，打不通即留在现有连接。端口映射只在家庭侧有可达公网 IPv4 时可能挽回部分失败（公开数据中有无映射组的直连差约 6.9 个百分点，且非本场景），家庭侧 CGNAT 时无效，还要处理租约与路由器兼容。以后若考虑，先用成对实测（同一手机、电脑、线路、短时间内有无映射对照）量出实际收益再决定。

### D13. 何时提供直连（`offered`）

电脑在信令连接的升级请求上判定，只认电脑自己能确认的事实，按顺序取第一条命中的结果：

1. 本机访问（`isLocalConnection`）→ `false`。
2. 连接来自 codexhost Relay 隧道（`trust.relaySockets` 中有该 socket）→ `true`。
3. 直连对端是显式配置的可信代理（`--trusted-proxy` 中的地址，如另一台机器上的 nginx）→ `true`，不论代理自身是否在私有网段。
4. 直连对端是回环地址（隧道或代理终点在本机：`cloudflared`、frpc、本机 nginx、Tailscale Serve / Funnel）：
   - `x-forwarded-for` 末项属于 Tailscale 地址（`100.64.0.0/10` 或 `fd7a:115c:a1e0::/48`）→ `false`，这是经 Tailscale Serve 的 tailnet 内访问。不依赖 `trust.trustLoopback` 是否已刷新，Serve 刚开启时同样不尝试、不查询 STUN；
   - 其余（Funnel 的公网客户端、cloudflared、frp、本机 nginx）→ `true`。
5. 其他直接 TCP 连接（局域网私有地址 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`、`fc00::/7`、`fe80::/10`；Tailscale IP `100.64.0.0/10`、`fd7a:115c:a1e0::/48`；以及经端口转发的公网地址）→ `false`，这些路径本身已是直连。

覆盖变量设为空时一律 `false`。

`offered` 只是避免无益尝试的优化，不是安全边界：伪造的转发头最多让判定出错，直连仍需已认证信令与指纹绑定。已知误差：tailnet 客户端若经其他本机代理（而非 Serve）访问，也会因转发头落在 Tailscale 网段而不尝试，这本身已是直连路径。

## Risks / Trade-offs

- [直连使手机与电脑互相看到对方公网地址；内置 STUN 服务方能看到两端地址与查询时间，看不到内容] → 只在经中转入口时尝试；日志不记录地址；面向用户的说明由用户在文档中补充。
- [经 Cloudflare Tunnel 或外部 nginx 时，TLS 在入口终止，入口方可改写信令与页面] → 直连的可信程度与页面本身相同、不高于入口；不另做设备密钥固定。
- [第三方 STUN 无服务承诺，可能下线或限速] → 多家并行，任一可用即可；全部不可用时仍可用本地候选，最差回到现有连接。
- [文件与画面共用 SCTP 关联导致画面卡顿] → 小片发送、画面优先、文件通道独立待发上限；原型验证混合负载。
- [蜂窝网络 CGN 下直连率低] → 退避避免反复尝试；不引入 TURN 是已接受的取舍。
- [werift 为纯 TypeScript，传输占 Node 主线程 CPU；低功耗电脑可能更高] → 30 fps × 160 KiB 本机约 20% 单核；`[direct] session` 记录直连字节，必要时以 Pion 子进程隔离（D11）。
- [werift 仍在快速迭代（多网卡、trickle、nomination）] → 锁定 0.28.x，升级时重跑建连与回退测试。
- [werift 电脑端候选收集完成较慢（约 5 秒）] → 强制 trickle，不等待收集完成（D2）。

## Migration

- 无持久化格式迁移：电脑只新增 `target` ID 文件；手机只新增 `codexhost.direct.v1` 键。
- 旧页面不发信令，行为与现在相同；新页面连旧 Web 时信令连接收不到 `direct-hello`，客户端不尝试直连。客户端与 Web 服务端须配套更新，与现有侧栏浏览器协议的约束一致。
- 回滚：移除直连后所有流量回到现有连接；手机上的残留键无副作用。

## Open Questions

- 预览直连是否需要额外的大小上限。默认沿用现有预览限额，下载始终走 HTTP。
