# Tasks

行为验收见 [web-direct-connection](specs/web-direct-connection/spec.md)，技术决策见 [design](design.md)。每个任务可单独提交；第 1 组完成前，第 2、3 组不开始。面向用户的文档（`docs/product/standalone-web.md`、`docs/product/web-remote-access.md`）在实现完成后单独编写，实现任务不含文档更新。

## 0. 前置结论（先于 1.2）

- [x] 0.1 汇总电脑端 WebRTC 实现与 UPnP 调研、DataChannel 原型实测，定下 D11（`werift` 0.28.x）与 D12（首版不做端口映射），并校准 D2 的 trickle 与超时、D3 / D4 的分片、背压、代次隔离与心跳。结论与证据：`research-p2p-stack-codex.md`、`p2p-spike-results.md`。

## 1. 侧栏浏览器画面

- [x] 1.1 共享契约：信令消息、标签 `transport` 消息、直连帧分片与 `ack` 的编解码，内置 STUN 列表。验证：`packages/shared-contracts` 的编解码单测覆盖非法消息与分片边界；`npx tsc -b packages/shared-contracts`。
- [ ] 1.2 电脑端直连会话：引入 `werift` 0.28.x 并纳入 Web bundle、不带 `tab` 的信令连接、`direct-hello`（`target` 持久化、`boot`、按 D13 判定 `offered`）、offer 后立即 answer 并逐个 trickle 候选（不等收集完成）、单尝试与 10 秒超时、按 `attempt` 代次隔离旧事件与候选、`control` 通道心跳、指纹绑定后的 `direct-ready`、凭据登记与撤销关闭、`CODEXHOST_WEB_STUN_URLS` 校验、`[direct]` 观测日志。验证：web-server 测试用两个进程内对端完成建连，且 answer 在电脑端候选收集完成前发出、一个 STUN 不响应时连通检查在约 1.5 秒内开始；旧代次连接关闭不影响新连接；心跳超时判为断开；`offered` 对本机、局域网、Tailscale IP、Tailscale Serve（tailnet 客户端，含 `trustLoopback` 未刷新时）、覆盖变量为空、Funnel、Relay、可信代理、cloudflared 式回环转发各取正确值；重新生成 token 后通道关闭且无后续写入；覆盖变量含 `turn:` 时启动失败；日志不含地址。
- [ ] 1.3 画面经直连：标签 `transport` 绑定与同凭据校验、帧分片发送（单条 ≤ 16 KiB 且不超过协商 `maxMessageSize`，片头带代次）、`bufferedAmount` 128 KiB 暂停 / 64 KiB 恢复、累计确认跨路径、在途窗口与交付速率按路径计算、通道关闭与连接断开事件发生时立即回退并经标签连接补发当前画面、无确认超时仅作静默卡死兜底。验证：`sidebar-browser-tab` 测试覆盖切换前后不倒退、跨凭据拒绝、断开事件后不等超时即回退补发、静默卡死兜底回退、越界或旧代次分片被拒绝、回退后 2 倍 / 1 倍判定不受旧路径样本影响。
- [ ] 1.4 客户端建连与退避：页面级直连、首个反射候选得出 `network`（缓存 offer 至此再判断冷却）、冷却表、`boot` 变化与换网络重置、断开时立即回退、后台快速重连（`restart` offer，失败再完整重协商）与切回、后台不计失败、`direct-skipped`，界面不出现任何直连状态或入口。验证：退避与重置（仅换网络、Web 重启）的纯逻辑单测；用户经 Relay 与 Cloudflare Tunnel 在 iOS Safari、Android Chrome（Wi-Fi 与蜂窝）真机检查滑动与动画、断网时画面立即回到中转、冷却期不尝试、同一 Wi-Fi 与 Tailscale 访问不尝试，并从日志读出直连占比与建连时间。iPhone Safari 真机验收（用户执行）：同一 Wi-Fi、蜂窝跨网、开启与关闭 iCloud 私密中继、Wi-Fi↔蜂窝切换、锁屏后恢复，各记录是否直连、建连时间与回退是否无感。

## 2. 手机上传

- [ ] 2.1 附件上传经直连：客户端路由判断（就绪且白名单才走直连）、请求通道上的上传格式、电脑以绑定凭据调用现有上传处理、未收到结束标记即丢弃、直连断开时立即改经 HTTP 重传、画面优先的发送调度、观测字节数。验证：web-server 测试覆盖经直连上传与 HTTP 结果一致、超限错误一致、中途断开不留文件；用户真机检查上传时侧栏浏览器画面不卡顿。

## 3. 小文件与侧边预览

- [ ] 3.1 预览与聊天图片经直连：电脑端只读方法白名单（文本 / 代码、图片、PDF）与 `/api/file` 栅格图片限制、非白名单返回“不支持”后客户端改走 HTTP、音视频与 HTML 预览及下载保持 HTTP、直连断开时立即改走 HTTP。验证：web-server 测试覆盖白名单内外方法、`.svg` 拒绝、响应与 HTTP 一致、响应头前失败改走 HTTP；用户真机检查图片、PDF、代码预览。
