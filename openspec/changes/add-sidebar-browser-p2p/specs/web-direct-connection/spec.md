# Spec Delta

## Purpose

让经中转入口远程访问 Web 的手机浏览器在能与电脑打通 UDP 直连时，把侧栏浏览器画面、附件上传和小文件预览改经 WebRTC 直连传输，打不通或断开时无感留在现有连接。

## ADDED Requirements

### Requirement: 直连承载的流量

直连 SHALL 只承载侧栏浏览器画面（含帧确认）、附件上传，以及图片、PDF、代码与文本的侧栏预览和聊天图片读取。音视频预览、HTML 预览、文件下载、终端、Agent 流式输出、侧栏浏览器的导航与输入、其他 API 和页面资源 MUST 继续使用现有 HTTPS / WebSocket，无论直连是否就绪。

#### Scenario: 直连就绪时打开 PDF 预览
- **WHEN** 直连已就绪，用户在右侧栏预览一个 PDF
- **THEN** 文件内容经直连传输，预览结果与经 HTTP 时相同

#### Scenario: 直连就绪时预览视频或下载文件
- **WHEN** 直连已就绪，用户预览一个视频、拖动进度条，或下载一个工作区文件
- **THEN** 请求经现有 HTTP 发出，行为不变

#### Scenario: 直连就绪时使用终端
- **WHEN** 直连已就绪，用户在终端输入命令或查看 Agent 输出
- **THEN** 这些流量仍经现有 WebSocket，不经直连

### Requirement: 只在经中转入口访问时尝试

只有页面经中转入口（codexhost Relay、Tailscale Funnel、Cloudflare Tunnel、frp、反向代理等）访问时，系统才 SHALL 尝试直连。本机访问、局域网直接访问、经 Tailscale 网络（含 Tailscale Serve）访问，以及其他不经中转的直接访问 MUST NOT 尝试直连，也 MUST NOT 查询 STUN。

#### Scenario: 经 Relay 访问
- **WHEN** 手机经 codexhost Relay 地址打开 Web
- **THEN** 页面在后台尝试直连

#### Scenario: 同一 Wi-Fi 访问
- **WHEN** 手机经电脑的局域网地址打开 Web
- **THEN** 页面不查询 STUN，也不建立直连

#### Scenario: 经 Tailscale 访问
- **WHEN** 手机经 Tailscale IP 或 Tailscale Serve 的 HTTPS 地址打开 Web
- **THEN** 页面不查询 STUN，也不建立直连

#### Scenario: 经 Tailscale Funnel 访问
- **WHEN** 未加入 tailnet 的手机经 Funnel 公开地址打开 Web
- **THEN** 页面在后台尝试直连

#### Scenario: 本机访问
- **WHEN** 用户在电脑本机打开 Web
- **THEN** 页面不查询 STUN，也不建立直连

### Requirement: 先用现有连接再升级

页面 SHALL 先经现有连接完成加载与显示，建连期间所有流量照常走现有连接；尝试 MUST NOT 延迟首帧、上传或预览。只有电脑确认直连可用后，客户端才 SHALL 把上述流量切到直连。切换 MUST NOT 让画面倒退、重复显示旧帧或丢失输入。

#### Scenario: 直连建立前画面照常显示
- **WHEN** 手机经中转打开侧栏浏览器，直连仍在建立
- **THEN** 画面经现有 WebSocket 照常显示和刷新

#### Scenario: 直连建立后切换
- **WHEN** 侧栏浏览器正在显示画面时直连就绪
- **THEN** 之后的画面经直连到达，切换期间不出现比已显示画面更旧的帧

#### Scenario: 直连就绪前开始的上传
- **WHEN** 上传在直连就绪前已经开始
- **THEN** 该上传经 HTTP 完成，不中途切换

### Requirement: 失败与断开时立即回退

直连通道关闭、出错，连接报告失败、断开，或直连心跳超时时，受影响的流量 SHALL 立即回到现有连接，MUST NOT 等待更长的超时：画面经现有 WebSocket 补发当前画面并继续推送；未收到响应的预览读取改经 HTTP 重新请求；未完成的上传改经 HTTP 重新上传，电脑 MUST 丢弃不完整的直连上传。没有上述事件但直连上的画面长时间未获确认时，也 SHALL 按断开回退。

#### Scenario: 直连中途断开
- **WHEN** 画面经直连推送时手机网络抖动，直连报告断开
- **THEN** 画面立即回到现有 WebSocket 并补发当前画面，用户不需要刷新

#### Scenario: 上传进行中直连断开
- **WHEN** 一个附件经直连上传到一半时直连断开
- **THEN** 该附件立即经 HTTP 重新上传并成功，电脑上不留下不完整的文件

#### Scenario: 对端消失但未发出关闭通知
- **WHEN** 手机上的旧版 Safari 关闭直连却没有发出关闭事件
- **THEN** 电脑在直连心跳超时后立即停止经直连发送，该页面后续的流量走现有连接

#### Scenario: 直连静默卡死
- **WHEN** 直连没有报告断开，但经它发出的画面持续数秒未获确认
- **THEN** 画面回到现有 WebSocket 并补发当前画面

#### Scenario: 直连无法建立
- **WHEN** 手机所在网络阻断 UDP，直连始终无法建立
- **THEN** 所有功能经现有连接正常使用

### Requirement: 断开后的快速重连

已建立的直连断开、流量回到现有连接后，客户端 SHALL 在后台快速重连至多两次，成功则再切回直连；仍未恢复才按一次失败计入退避。页面进入后台或被系统挂起导致的断开 MUST NOT 计入失败，回到前台时在不处于冷却期的情况下 SHALL 重新尝试。

#### Scenario: 短暂断开后恢复
- **WHEN** 直连断开后第一次快速重连成功
- **THEN** 断开期间流量走现有连接，重连成功后回到直连，不计入失败

#### Scenario: 重连仍失败
- **WHEN** 直连断开后两次快速重连都失败
- **THEN** 流量留在现有连接，并按一次失败进入冷却

#### Scenario: 锁屏后回来
- **WHEN** 手机锁屏导致直连断开，之后解锁回到页面
- **THEN** 不计入失败，页面重新尝试直连

### Requirement: 直连对用户不可见

直连的尝试、成功、失败、回退与冷却 SHALL 对用户完全无感：界面 MUST NOT 显示直连状态、开关、重试入口或与直连相关的错误与提示。

#### Scenario: 直连失败
- **WHEN** 直连建立失败并进入冷却
- **THEN** 页面不出现任何提示，功能照常经现有连接使用

#### Scenario: 查看界面
- **WHEN** 用户浏览侧栏浏览器、设置与连接设备页
- **THEN** 找不到直连状态、开关或重试入口

### Requirement: 信令与凭据绑定

直连的 SDP、DTLS 证书指纹与候选 MUST 只经已认证、同源校验的 `/api/sidebar-browser` WebSocket 交换。每个直连 SHALL 绑定建立它的登录凭据与信令连接；电脑 MUST 只接受与本次信令交换的指纹一致的对端，并在确认绑定后才收发数据。侧栏浏览器标签只能使用同一凭据建立的直连。

#### Scenario: 未认证的信令
- **WHEN** 未登录的请求连接 `/api/sidebar-browser` 并发送 offer
- **THEN** 连接被拒绝，电脑不分配任何直连资源

#### Scenario: 指纹不符的对端
- **WHEN** 一个对端完成 ICE 连通，但其 DTLS 证书与本次信令交换的指纹不一致
- **THEN** 电脑拒绝该连接，不发送画面或文件内容

#### Scenario: 跨凭据使用直连
- **WHEN** 一个标签连接请求使用另一个登录凭据建立的直连
- **THEN** 电脑拒绝切换，该标签继续使用现有 WebSocket

### Requirement: 凭据失效时关闭直连

重新生成 token、退出登录或信令连接关闭时，电脑 SHALL 立即关闭对应直连，MUST NOT 再经其发送任何画面、文件内容或上传结果。之后只能经新的已认证信令重新建立直连。

#### Scenario: 令牌撤销时关闭直连
- **WHEN** 手机正经直连观看侧栏浏览器时 token 被重新生成
- **THEN** 直连立即关闭，不再收到画面，页面按现有规则进入登录页

#### Scenario: 退出登录
- **WHEN** 用户在手机上退出登录
- **THEN** 该浏览器的直连随即关闭

### Requirement: 失败退避

客户端 SHALL 在本地按“手机网络环境 + 目标电脑”记录直连失败；网络环境由 STUN 观察到的公网地址确定。连续失败后的冷却依次为 10 分钟、1 小时、6 小时，此后每次 24 小时；冷却期内 MUST NOT 尝试直连。成功建立直连 SHALL 清除该记录。本地存储不可用时退避只在当前页面内有效。电脑 MUST NOT 保存手机网络信息。

#### Scenario: 冷却期内不再尝试
- **WHEN** 在同一网络对同一电脑的直连刚失败一次，用户 5 分钟后刷新页面
- **THEN** 页面不发起直连信令，所有流量经现有连接

#### Scenario: 冷却逐级延长
- **WHEN** 同一网络对同一电脑连续失败四次
- **THEN** 冷却依次为 10 分钟、1 小时、6 小时、24 小时，之后每次失败仍为 24 小时

#### Scenario: 成功后清零
- **WHEN** 曾失败过的网络上直连成功建立
- **THEN** 该网络的失败记录被清除，之后的失败从 10 分钟重新开始

### Requirement: 退避重置

手机换到另一网络环境，或电脑上的 Web 重新启动后，系统 SHALL 不受已有冷却限制，立即允许重新尝试。除此之外冷却 MUST NOT 被提前结束。

#### Scenario: 换网络后重新尝试
- **WHEN** 手机在 Wi-Fi 下处于冷却期，随后切换到蜂窝网络
- **THEN** 页面在新网络下立即尝试直连

#### Scenario: 电脑 Web 重启
- **WHEN** 处于冷却期时电脑上的 Web 重新启动，手机重新连上
- **THEN** 页面立即尝试直连

### Requirement: 内置 STUN 且不使用 TURN

手机与电脑 SHALL 使用同一组内置 STUN 服务器并行收集候选，默认为 `stun.douyucdn.cn:18000`、`stun.hitv.com:3478`、`stun.chat.bilibili.com:3478`、`stun.miwifi.com:3478`、`global.stun.twilio.com:3478`、`stun.cloudflare.com:3478`。界面与用户设置 MUST NOT 提供 STUN 配置。系统 MUST NOT 使用 TURN。仅开发用环境变量可覆盖 STUN 列表，且只接受 `stun:` 地址。

#### Scenario: 部分 STUN 不可达
- **WHEN** 手机网络无法访问其中几个 STUN 服务器
- **THEN** 其余服务器的结果照常用于建连，不提示用户

#### Scenario: 覆盖列表含 TURN
- **WHEN** 开发者在覆盖变量中写入 `turn:` 地址
- **THEN** Web 启动失败并说明只接受 STUN 地址

#### Scenario: 不经中继服务器
- **WHEN** 直连建立
- **THEN** 选中的候选对两端都不是中继候选

### Requirement: 直连不改变访问结果

经直连的上传与预览 MUST 与经 HTTP 时使用相同的登录凭据、权限、工作目录范围、大小与格式限制，返回相同的结果与错误。HTML 与 SVG 等不允许直接返回的文件 MUST NOT 经直连返回。

#### Scenario: 超限附件
- **WHEN** 经直连上传一个超过现有大小上限的附件
- **THEN** 得到与 HTTP 上传相同的错误

#### Scenario: 请求不允许的文件类型
- **WHEN** 经直连读取聊天图片的请求指向一个 `.svg` 文件
- **THEN** 电脑拒绝，与 HTTP 行为一致

### Requirement: 直连观测

电脑 SHALL 在 Web 日志中记录每次直连尝试的结果、失败或关闭原因、从发起到就绪的耗时、选中候选对的类型，以及画面、上传、预览分别经直连与现有连接传输的字节数，以统计直连占比和建连时间。客户端因冷却跳过尝试时 SHALL 告知电脑以便计入。日志 MUST NOT 包含 IP 地址、候选地址或传输内容。

#### Scenario: 一次成功的直连
- **WHEN** 一次直连在 2 秒内就绪并承载了画面
- **THEN** 日志记录成功、耗时、候选对类型和经直连的画面字节数，不含任何地址

#### Scenario: 冷却期跳过
- **WHEN** 客户端因冷却跳过直连
- **THEN** 日志记录一次因冷却跳过，不记录手机网络信息
