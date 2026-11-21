# Proposal

## Why

手机浏览器（不装 App）经 codexhost Relay、Cloudflare Tunnel 或 Tailscale Funnel 等入口远程使用 Web 时，侧栏浏览器画面要绕行中转并与其他流量共用一条连接，用户反馈滑动和动画“非常非常慢，卡顿”。手机与电脑之间常能打通 UDP 直连；把画面等少数大流量改走直连，可以绕开中转的往返与排队。

## What Changes

- 新增**直连通道**：页面经中转入口（Relay、Tunnel、反向代理等）访问时，先照常经现有 HTTPS / WebSocket 工作，同时在后台用 WebRTC DataChannel 尝试与电脑直连；建立并确认后才切换，失败、断开时立即回到现有连接。本机、局域网、Tailscale 等本身已直连的访问不尝试。
- 直连对用户完全无感：界面不出现直连状态、开关或重试入口。
- 直连只承载三类流量：**侧栏浏览器画面**、**手机上传附件**、**小文件与侧边预览**（图片、PDF、代码/文本）。音视频预览、HTML 预览、大文件下载、终端、Agent 流式输出、普通 API 和页面资源仍走现有连接。
- 信令（SDP 与候选）只经已认证、同源校验的 `/api/sidebar-browser` WebSocket 交换，直连与发起它的登录凭据绑定；重新生成 token、退出登录或信令连接结束时立即关闭直连。
- 手机浏览器本地按“手机网络环境 + 目标电脑”记住失败，冷却 10 分钟 → 1 小时 → 6 小时 → 最长 24 小时；只在换网络或电脑 Web 重启时重置。
- 内置一组 STUN 服务器并行使用，不提供用户配置；不使用 TURN。只保留一个开发用环境变量覆盖 STUN 列表。

## Decisions

- **对用户无感，失败立即回退。** 用户不需要感知直连；任何断开事件都立即切回中转，不等待超时，也不提供手动重试。
- **直连是附加路径，不是新入口。** 首次加载、登录、信令和回退都依赖现有入口；入口不可用时直连也不尝试，不处理“中转本身不可用”的情况。
- **只用 DataChannel，不用媒体轨。** 画面沿用现有逐帧图像、帧序号与累计确认，保持现有 2 倍 / 1 倍降级与输入语义，避免为直连引入视频编码。
- **不使用 TURN。** TURN 是另一项需运营、计费并能看到流量元数据的服务；打不通直连时现有连接就是回退，不再加一层中转。
- **STUN 不可配置。** 用户无法判断哪些 STUN 在自己的网络可用，内置多家国内外服务并行查询，由 ICE 自行选择；仅为开发调试保留环境变量。
- **退避状态只存在手机浏览器。** 电脑不保存任何手机网络信息；清除站点数据即重置。
- **电脑端用 `werift`（0.28.x），在 Web 的 Node 进程内运行。** 唯一能并行查询全部内置 STUN 的候选，支持 ICE restart，纯 TypeScript 随现有 Web bundle 打包，无原生依赖；node-datachannel、复用服务器 Chrome、Pion、wrtc 的取舍见 design D11。
- **首版不做 UPnP / NAT-PMP / PCP 端口映射。** 收益未经本场景实测，以后先做成对实测再决定。

## Capabilities

### New Capabilities

- `web-direct-connection`：Web 页面与电脑之间的 WebRTC 直连：适用流量、建立与切换、回退、信令与凭据绑定、失败退避、内置 STUN、观测。

### Modified Capabilities

（无。令牌撤销对直连的影响作为新能力的需求写入，不改变 `web-access-tokens` 已有行为。）

## Impact

- `packages/shared-contracts`：`/api/sidebar-browser` 增加信令消息与直连帧分片格式、内置 STUN 列表。
- `packages/web-server`：电脑端 WebRTC 会话、信令处理、凭据绑定与撤销、画面经直连发送、上传与预览请求的直连入口、观测日志；新增 `werift` 0.28.x 运行时依赖，随 Web bundle 打包。
- `apps/web-ui/packages/client/ui-sidebar-browser` 及上传、预览所在客户端：建连、退避存储、请求路由。
- 文档：面向用户的直连与隐私说明在实现完成后单独编写，不在实现任务内。
- 隐私：直连使双方看到对方公网地址；内置 STUN 服务方能看到两端地址与查询时间，但看不到内容。
