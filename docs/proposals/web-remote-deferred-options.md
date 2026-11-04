# Web 远程访问暂缓方案记录

> 状态：第一版不做，未实现。调研日期为 2026-11-04，外部产品的状态可能已变化，重新评估时要先复核。
>
> 本文记录 P2P、Tailscale 相关方案和 Cloudflare Workers 中转的结论与依据，供之后重新考虑时快速查阅。第一版的方案见[总体设计](web-remote-relay-architecture.md)。

## 1. 结论

| 方案 | 第一版 | 主要原因 | 什么时候重新评估 |
| --- | --- | --- | --- |
| P2P 直连（WebRTC） | 不做 | 必须建立在中转之上；手机浏览器上没有成熟先例；国内成功率没有数据 | 官方中转上线后，带宽费用成为实际负担，或延迟影响使用 |
| Tailscale Peer Relays、DERP | 不集成 | 手机和电脑仍要安装 Tailscale | 不需要重新评估，可作为 Tailscale 用户的自助优化 |
| Tailcat | 不集成 | 手机上只走 DERP，没有直连；前端要大改；不保证 API 稳定 | 浏览器版支持 WebRTC 直连，并且 API 有稳定性承诺 |
| Cloudflare Workers 中转 | 不做 | 要多维护一套中转协议；Cloudflare 能看到内容；国内访问和免费额度未验证 | 开放自托管后，用户普遍反馈部署 VPS 太麻烦 |

已经在用 Cloudflare 的用户，第一版可以通过自备隧道使用 Cloudflare Tunnel。

## 2. 判断依据

产品形态决定了取舍：

- 用户在手机浏览器或 PWA 上访问，不开发原生 App，手机不安装额外软件。
- 官方中转使用 SNI 转发：中转不解密，TLS 在用户电脑上终止，页面由电脑提供。
- 官方中转由项目提供，带宽是项目的持续成本。

## 3. P2P

### 3.1 能带来什么

- **减少中转流量：** 直连成功时，中转基本只承载页面和少量控制数据。
- **降低延迟：** 手机和电脑都在国内时，直连可能比绕境外中转更快。这一点没有实测。
- **放宽限额：** 文件和截图走直连时不占中转带宽，官方中转的限制可以放宽。

直连失败的用户，中转流量与没有 P2P 时相同。

当前 Web 构建产物的 JS 和 CSS 合计约 6MB，合并后 gzip 约 1MB。首次加载的流量以此估算，实际值取决于服务端是否压缩和缓存情况。

### 3.2 如果要做，采用什么形态

1. 手机通过现有入口打开页面，并用 token 登录。
2. 页面和电脑通过这条已加密、已认证的连接交换 WebRTC 信息，不设单独的信令服务器。
3. 项目只需额外提供 STUN。公共 STUN 在国内的可达性未验证，建议和中转部署在一起。
4. 打洞成功就切换到 DataChannel；失败就留在原连接上。原连接就是兜底，不需要 TURN。

这个形态对官方中转、自托管中转和自备隧道都适用。

**范围上先做大流量，不动对话主通道：**

| 流量 | 是否走 P2P | 原因 |
| --- | --- | --- |
| Agent 对话、终端 | 留在中转 | 流量小，但最怕断线和乱序，收益最小、风险最大 |
| 侧栏浏览器推流、截图、大文件 | 优先尝试 | 最占带宽；失败时退回中转，不涉及对话消息切换通道 |

[Alma](https://github.com/yetone/alma-relay) 和 [Tailcatchat](https://github.com/tailscale/tailcatchat) 都是类似的分工：控制或文字走中继，实时画面走 WebRTC。

### 3.3 代价

- **传输不统一：** 流式数据走 `/api/remote.mux`，RPC 走 `POST /api/...`，图片走 `/api/file`，侧栏浏览器有单独的 WebSocket。要省流量，就要逐条接入。
- **新增依赖：** 项目当前没有 WebRTC 依赖。电脑端可选 `node-datachannel`（各平台原生包）或 `werift`（纯 TS，性能未验证）。
- **连接切换：** 手机切换网络或 iOS 切后台后，直连可能中断，要退回中转再重新打洞，同时不能丢消息或乱序。
- **认证联动：** 重新生成 token 时要同时断开旧 token 建立的直连。
- **排查成本：** 直连失败的原因与网络环境相关，难以复现。

### 3.4 同类产品的做法

手机或 Web 远程访问本地 Agent 的产品，**没有发现把 P2P 用作 Agent 对话主通道的**，主流做法是电脑主动连中继，手机也连中继。没有发现产品先做 P2P、又因成功率放弃而改回纯中继的案例；也没有发现这类产品实测过 WebRTC 打通三大运营商。没人这样做不等于做不成，只是没有现成先例。

下表来自联网调研。除第 3.5 节标注“已核对原文”的内容外，其余未逐条复核。

| 产品 | 传输路径 | P2P | 浏览器能否直连 |
| --- | --- | --- | --- |
| [Happy](https://happy.engineering/docs/how-it-works/) | 两端出站连中继，应用层 E2E，中继存转发密文 | 否 | 否 |
| [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control) | 本机出站 HTTPS 到 Anthropic，手机连 claude.ai | 否 | 否 |
| [Codex 远程](https://learn.chatgpt.com/docs/remote-connections.md) | 官方 secure relay 连接已配对主机 | 否 | 否 |
| [Cursor Remote Control](https://cursor.com/changelog/remote-control-local-agents) | iOS App 与桌面配对，传输方式未公开 | 未说明 | 未说明 |
| [Omnara](https://news.ycombinator.com/item?id=46991591) | daemon 出站 WebSocket，服务器可读明文 | 否 | 否 |
| [Alma](https://github.com/yetone/alma-relay) | 控制面走中继并 E2E，画面走 WebRTC；原生 App | 仅画面 | 无公开 Web 客户端 |
| [HAPI](https://github.com/tiann/hapi/blob/main/docs/guide/how-it-works.md) | 局域网直连 hub；远程用 tunwg 出站到中继 | 否 | 否，经公网 HTTPS 或局域网 |
| [Paseo](https://paseo.sh/docs/security) | 推荐中继加 E2E；可选直连 TCP 或 Tailscale | 否，不打洞 | 可直连 daemon，不打洞 |
| [OpenCode](https://opencode.ai/v2/docs/cli/web/) | 本机 HTTP；`pair --remote` 走 OpenTunnel（SNI，TLS 在本机终止） | 否 | 经公网 URL |
| [VibeTunnel](https://github.com/amantus-ai/vibetunnel) | 本机 HTTP/WebSocket，远程靠用户自备 Tailscale 或 ngrok | 否 | 否 |
| [VS Code Tunnels](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started) | 主机出站连 Azure，始终中继 | 否 | 否 |
| [Home Assistant Remote UI](https://github.com/NabuCasa/snitun) | SNI 转发，中继不解密 | 否 | 否 |
| [Coder](https://coder.com/docs/networking/) | WireGuard，失败走 DERP | 原生客户端可以 | **否** |
| [Tailscale](https://tailscale.com/blog/nat-traversal-improvements-pt-1) | WireGuard 打洞，失败走 DERP 或 Peer Relay | 是 | **否，默认只走 DERP** |
| [RustDesk](https://github.com/rustdesk/rustdesk-server) | 信令加打洞，失败走中继 | 是 | Web 客户端不具备完整打洞能力 |
| [Syncthing](https://docs.syncthing.net/users/relaying.html) | 优先直连，失败走中继，中继只转密文 | 是 | 无浏览器同步客户端 |
| [PairDrop](https://github.com/schlagmichdoch/PairDrop/blob/master/docs/technical-documentation.md) | 浏览器 WebRTC 传文件，跨 NAT 走 TURN | 是 | 是，但场景是传文件 |
| [webtty](https://github.com/maxmcd/webtty) | 浏览器 WebRTC 终端，没有 TURN，约 2022 年后停更 | 是 | 是，但已停更 |

### 3.5 关键证据

**已核对原文：**

- **Coder 从 WebRTC 换成了 Tailscale。** [Issue #2779](https://github.com/coder/coder/issues/2779)（2022）列出的原因是连接问题、吞吐量约 30mb/s，以及要维护约 3000 行需要专门知识的网络代码。它的[现行文档](https://coder.com/docs/networking)写明浏览器不支持直连。这不是手机 PWA 场景，只能部分参考。
- **Tailscale 的浏览器设备全部走 DERP。** [Issue #21027](https://github.com/tailscale/tailscale/issues/21027)（2026-08）提议增加 WebRTC 路径，原因是浏览器不提供通用 UDP。核对时仍未关闭。
- **Tailcatchat 的分工。** [README](https://github.com/tailscale/tailcatchat) 写明文字和文件走 DERP，实时音视频走 WebRTC，打洞信息通过已加密的控制流交换。它没有 TURN，直连失败时音视频可能连不上，文字不受影响。

**来自调研，未复核：**

- **Happy** 在[文档](https://happy.engineering/docs/how-it-works/)中说明不直连的原因：防火墙使手机和电脑通常连不上，手机断网时还要靠中继暂存消息。
- **Tailscale #21027** 中的实验称 WebRTC 可超过 200 Mbps，DERP 约 25 Mbps。
- **HAPI** 的 [Issue #147](https://github.com/tiann/hapi/issues/147) 反映企业网常拦 UDP，WireGuard 中继会失败。

### 3.6 直连成功率

没有找到中国大陆带样本量或运营商拆分的公开数据。现有信息都不能当成功率使用：

| 来源 | 内容 | 局限 |
| --- | --- | --- |
| [Tailscale（2025-10）](https://tailscale.com/blog/nat-traversal-improvements-pt-1) | 典型条件下打洞成功率远超 90%；手机运营商级 NAT、对称 NAT 下很可能走 DERP | 全球数据，非大陆，非手机浏览器 |
| [RustDesk 讨论（2023-12）](https://github.com/rustdesk/rustdesk/discussions/6689) | 中国用户反馈成功率差、多数走中继 | 个人反馈，没有数字 |
| ToDesk、向日葵的评测文章 | 称直连成功率高 | 没有方法和样本，不采用 |

IPv6 可能提高国内的成功率，未验证。

### 3.7 iOS 和 PWA 的问题

- **切后台会停网。** [Apple 确认](https://developer.apple.com/forums/thread/799259) App 挂起后底层网络全部停止。WebSocket 也一样，回前台都要重连。
- **DataChannel 可能静默断开。** 弱网下可能不触发 `onclose` 和 `onerror`，需要应用层心跳。来自[二手资料](https://www.videosdk.live/developer-hub/webrtc/webrtc-safari)。
- **大数据量传输可能卡住。** 社区反馈 iOS Safari 上传输数 MB 时会 stall，未复现。
- **PWA 恢复。** [WebKit #211018](https://bugs.webkit.org/show_bug.cgi?id=211018) 记录过带 Service Worker 的主屏 PWA 切回后 JS 不恢复的问题，较新的 iOS 是否仍有未验证。

### 3.8 重新评估时先验证

- 三大运营商手机网络和办公网，分别连接家庭宽带上的电脑，记录直连成功率和延迟，并区分 IPv4 和 IPv6。
- iOS Safari 和主屏 PWA 上 DataChannel 的吞吐、切后台恢复和网络切换。
- 官方中转的实际带宽费用，以及其中大流量内容的占比。没有这组数据，就无法判断 P2P 的收益。

## 4. Tailscale 相关方案

Tailscale 的前提是**手机和电脑都要安装，并登录同一账号**；手机上要保持 VPN 开启，iOS 同时只能开一个 VPN。所以它只适合已经在用或愿意配置的用户，不能作为大多数人的默认方式。

[Peer Relays](https://tailscale.com/blog/peer-relays-ga)（2026-02 正式可用）和开源的 [DERP](https://tailscale.com/blog/opensource) 只转发 Tailscale 设备之间的流量，所以不能解决安装问题。

它们可以改善国内 Tailscale 用户的延迟，用户自行配置即可，项目不用开发：

| 个案 | 官方境外中继 | 国内自建中继 |
| --- | --- | --- |
| [家宽 CGNAT + 酒店网络](https://x.com/losingle/status/2116664727996956716)（Peer Relay） | 约 300ms | 50–100ms |
| [移动家宽](https://blog.opentrading.tech/blog/tailscale-derp-optimization/)（自建 DERP） | 470–930ms | 18–34ms |

以上是个人分享，未复核。

## 5. Tailcat

[Tailcat](https://github.com/tailscale/tailcat) 于 2026 年 8 月开源（BSD-3-Clause），使用 Tailscale 的数据面，但不使用其控制面：不需要账号和管理员权限，DERP 可以自建，也可以用限速的公共节点。它有编译成 WebAssembly 的实验性浏览器版本。

| | Tailcat | SNI 中转 |
| --- | --- | --- |
| 手机安装 | 不用 | 不用 |
| 手机直连 | 目前没有，[WebRTC 支持](https://github.com/tailscale/tailcat/issues/4)未完成 | 没有 |
| 页面来源 | 公网静态站点 | 用户电脑 |
| 现有前端改动 | 大，HTTP、WebSocket、图片都要改走 WebAssembly 隧道 | 很小 |
| 中转和证书 | DERP 现成，不用给每个用户签证书 | 要开发或集成中转，并处理证书 |
| 页面信任 | 发布方可以替换页面 | 页面来自用户电脑 |
| 成熟度 | README 明确不保证 API 和 CLI 稳定，公共节点无 SLA | SniTun 已用于 Home Assistant，代码和许可证待评估 |

它能省掉中转开发和证书，但会回到“公网静态前端加浏览器内加密”的形态，而这个形态已被总体设计否决。电脑端还要多带一个 Go 程序。

可以使用的场景是另一台电脑的访问：两边各运行一条 `tailcat` 命令，不需要账号和公网服务器。这属于自备隧道，手机浏览器用不了。以上判断来自 README 和 Issue，没有实际运行，包大小和手机表现未测。

## 6. Cloudflare Workers 中转

[alma-relay](https://github.com/yetone/alma-relay) 提供一键部署到 Cloudflare，免费套餐可用，不需要 VPS 或域名，自带 `*.workers.dev` 的 HTTPS 地址。这对用户最省事。

但做法不能原样照搬：

- **SNI 转发跑不起来。** Worker 拿到的是已解开 TLS 的 HTTP 请求，收不到原始 TLS 字节。这一点来自对 Workers 模型的了解，实施前要查证。
- **Cloudflare 能看到内容。** Alma 靠原生 App 做端到端加密，PWA 没有这一层，所以 Cloudflare 能看到对话内容和 token。

| | SNI 自托管中转 | Workers 中转 | Cloudflare Tunnel |
| --- | --- | --- | --- |
| 用户准备 | VPS 和域名 | Cloudflare 账号 | Cloudflare 账号，固定地址还要有托管在 Cloudflare 的域名 |
| 电脑额外安装 | 不用 | 不用 | `cloudflared` |
| 费用 | VPS 费用 | 免费额度内不花钱 | 未核实 |
| Cloudflare 能否看到内容 | 不涉及 | 能 | 能 |
| 项目开发 | 复用官方 Relay | 第二套中转协议和电脑端客户端 | 只写文档 |

**未验证的问题：**

- **国内访问：** `workers.dev` 在国内能否稳定访问。
- **免费额度：** Durable Objects 免费版每天约 [10 万次请求，WebSocket 消息也计入](https://developers.cloudflare.com/durable-objects/platform/pricing)，超出后报错。Agent 流式输出和终端的消息很多，实际够不够要测。额度以 Cloudflare 当前文档为准。

**如果要做：**

- alma-relay 是 MIT 许可，[协议有文档](https://github.com/yetone/alma-relay/blob/main/docs/PROTOCOL.md)，`cloudflare/worker.mjs` 可以参考。
- 它按路径寻址，而前端使用 `/api/...` 这类绝对路径。每个用户单独部署时要去掉这层路径。
- 部署说明要写清楚 Cloudflare 能看到内容。
- 先部署一个 Worker，用三大运营商的手机网络测试连通性和延迟，再决定是否投入开发。
