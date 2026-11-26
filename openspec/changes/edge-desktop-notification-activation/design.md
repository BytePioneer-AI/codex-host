## Design

### 激活链路

1. Edge 继续保存现有 PushSubscription 并显示原通知。每次点击生成 requestId，Service Worker 通过现有 `pushRequest()` 发送 requestId、`endpoint` 和 `sessionId`，请求 `codexhost/desktopSessionActivate`。
2. Web 服务只接受 `context.auth.local === true` 的请求，并要求 endpoint 已登记且其 `owner` 与当前认证 credential 一致。`--no-auth`、relay、远程设备及不匹配的订阅不触发本机激活。
3. 服务读取完整的 `desktop-shell-ready.json`（PID、启动时间、可执行文件、版本）并检查 PID 存活；Launcher 再用 PID + 启动时间核验实际实例。不完整记录不得触发激活。原生壳未运行时返回 `activated: false`，Service Worker 执行原有 `clients.matchAll/focus/postMessage/openWindow`。
4. 原生壳运行时，服务用 `execFile(launcher, ["app", "--session", sessionId])` 和显式 `CODEXHOST_DATA_DIR` 调用 Launcher，不经过 shell、不接受 executable/URL/dataDir 参数。Launcher 退出码 `0` 表示壳已接管目标，`1` 表示明确未接管，`2` 表示结果未知；Web 分别返回 `activated: true`、`false`、`null`。服务以有界内存表按 requestId 记录或复用结果，重试不再次调用 Launcher。已接管不等于窗口已前置。
5. Launcher 复用现有 nonce 单实例通道发送 `ShowSession`。已有实例由主线程决定是否接管；退出中明确拒绝未接管的请求。启动竞态由 `app --session` 的首实例接手，在建窗并保存待打开目标后才确认。Web ready 前保存目标，ready 后用当次可信 login URL 打开，已就绪页面优先用现有 `face.openSession()` 与 Cookie。
6. 明确未接管激活时才允许 Web 回退。若原生回执丢失或 HTTP 响应丢失，Service Worker 以同一 requestId 查询一次；仍未知则不打开 Web，避免双开。

### 通知来源与设置

- 原生壳中的通知设置不创建 WebView2 PushSubscription，自动恢复订阅也跳过原生壳；已有 WebView2 订阅在原生页面初始化时退订。服务端退订失败不得阻断本地 unsubscribe 和 Service Worker unregister，确保旧 worker 不再续订或展示 WebView2 通知。
- 原生壳设置入口引导用户到 Edge 管理通知。Edge 设置页继续提供原启用、禁用和测试推送能力。
- 原生壳正在运行即表示本机 Edge 点击优先交给原生壳；原生壳未运行时不冷启动，保持浏览器行为。这是当前运行表面对点击目标的显式选择，不增加全局订阅偏好。

### 安全与兼容

- 授权依据为现有 `RequestAuth.local` 和订阅 owner，不使用可伪造的 User-Agent。sessionId 必须非空、有界且不含控制字符。
- token 不进入通知、激活 RPC、日志或启动参数；`app --session` 只接受会话 ID，不允许指定可执行文件、URL 或数据目录。
- 已接受激活与失败回退必须互斥，避免客户端和浏览器双开。迟到 RPC 不重复触发第二次激活。
- Windows 与 macOS 共用 RPC/Launcher/壳逻辑；窗口能否真正前置及 Edge 完全退出后的通知交付仍需真机验证。

## Constraints

不使用自定义 URI 协议、静态 launch 页、原生 Toast、WebView2 长驻 port、持久化订阅元数据或轮询。普通手机、远程浏览器和无原生壳用户的通知形式及点击行为保持不变。
