# Spec Delta

## Purpose

让 Web 通过出站连接注册到 Relay，用固定的 `https://<id>.<域名>` 被手机访问，TLS 在这台电脑上解开，Relay 看不到内容。

## ADDED Requirements

### Requirement: 中转设置

中转控制地址 SHALL 通过 `--relay <控制地址>` 配置，并像其他启动选项一样保存，传空值清除。没有配置时 MUST 不显示中转开关，也不发起连接。Web 以 `--no-auth` 运行时 MUST 拒绝开启中转。开关默认关闭，只能在本机访问时修改，状态保存并在重启后沿用；切换 MUST 即时生效，不重启 Web 或 Host。

#### Scenario: 未配置控制地址

- **WHEN** Web 启动时没有保存过 `--relay`
- **THEN** 连接设备页没有中转开关，Web 不连接任何 Relay

#### Scenario: 开启中转

- **WHEN** 已配置控制地址，用户在本机打开中转开关
- **THEN** Web 开始连接 Relay，运行中的任务和已连接的浏览器不受影响

#### Scenario: 未启用认证

- **WHEN** Web 以 `--no-auth` 运行，且保存的设置是开启中转
- **THEN** Web 不连接 Relay，打开开关的接口返回明确的错误

#### Scenario: 手机尝试修改开关

- **WHEN** 经中转或局域网访问的页面调用修改中转开关的接口
- **THEN** 接口拒绝，设置不变

### Requirement: 身份密钥

首次开启中转时，Web SHALL 生成身份密钥，保存在数据目录中只有当前用户可读的文件里，之后的重启和更新 MUST 沿用同一密钥。私钥 MUST NOT 离开这台电脑。连接设备页 SHALL 说明地址由该密钥决定、密钥文件的位置，以及密钥丢失或删除后地址会改变且无法找回。

#### Scenario: 更新后地址不变

- **WHEN** 升级 codexhost 后重新开启中转
- **THEN** 注册得到的地址与升级前相同

#### Scenario: 删除密钥

- **WHEN** 用户删除密钥文件后重新开启中转
- **THEN** Web 生成新密钥，得到新的地址，旧地址不再可用

### Requirement: 连接与注册

开启后 Web SHALL 通过 443 端口的出站 WSS 连接控制地址，按 Relay 协议完成注册并记录 Relay 返回的地址。一次连接尝试超过 30 秒未完成注册即放弃并按重连规则重试。环境变量 `HTTPS_PROXY` 指向 HTTP 代理时 MUST 经该代理连接。连接设备页 SHALL 显示状态：关闭、连接中、已连接（附地址）、缺少证书、已停止（附原因）。

#### Scenario: 注册成功

- **WHEN** 电脑能访问 Relay，注册通过
- **THEN** 连接设备页显示已连接和 `https://<id>.<域名>`

#### Scenario: 经代理连接

- **WHEN** 电脑只能通过 HTTP 代理访问外网，`HTTPS_PROXY` 已设置
- **THEN** Web 经代理连上 Relay 并完成注册

### Requirement: 断线重连

连接断开或连续 60 秒没有收到 Relay 心跳时，Web SHALL 自动重连，间隔带随机抖动并逐次增加，最长 60 秒；连接稳定一段时间后间隔重新计算。重连 MUST NOT 重启 Host 或 Web，地址和 token 不变。Relay 告知被同一身份替换、协议版本不被支持或签名被拒时，Web MUST 停止重连并显示原因。

#### Scenario: Relay 重启

- **WHEN** Relay 重启后恢复
- **THEN** Web 自动重新注册，运行中的任务继续，手机用原地址重新连接

#### Scenario: 电脑静默断网

- **WHEN** 网络中断但没有收到断开通知
- **THEN** Web 在约 60 秒内发现并开始重连

#### Scenario: 同一密钥在两台电脑上

- **WHEN** 另一台电脑用同一身份密钥注册，这台电脑被替换
- **THEN** 这台电脑停止重连，连接设备页说明地址正被另一台电脑使用

#### Scenario: Relay 不支持当前协议版本

- **WHEN** Relay 拒绝当前协议版本
- **THEN** Web 停止重连，提示更新 codexhost

### Requirement: 在电脑上解开 TLS

每条经 Relay 到达的手机连接 SHALL 在 Web 进程内用数据目录中的证书完成 TLS，只协商 HTTP/1.1，再交给现有 HTTP 服务；10 秒内未完成握手的连接 MUST 被关闭。Web MUST NOT 为此新开监听端口。没有可用证书时，Web SHALL 保持注册，把手机连接直接关闭，状态显示缺少证书。Web MUST NOT 通过 Alt-Svc 或其他方式宣告 HTTP/3 或 ECH。

#### Scenario: 手机经中转打开页面

- **WHEN** 证书有效，手机访问 `https://<id>.<域名>`
- **THEN** 手机看到的证书由这台电脑提供，页面、登录、RPC 和 WebSocket 都与其他入口一致

#### Scenario: 握手停滞

- **WHEN** 客户端发完 ClientHello 后不再发送
- **THEN** 10 秒后该连接被关闭

#### Scenario: 还没有证书

- **WHEN** 已注册但数据目录中没有证书
- **THEN** 手机连接被关闭，连接设备页显示缺少证书

### Requirement: 经中转请求的归属

经中转到达的请求 MUST 视为非本机访问和 HTTPS 访问：不能查看或修改 token，登录 Cookie 带 Secure，响应带 HSTS（不含子域），同源校验要求 Origin 完整等于 `https://<注册得到的主机名>`。登录失败限速 SHALL 按 Relay 告知的手机 IP 计数。这类请求携带的 `x-forwarded-*` 头 MUST 被忽略。

#### Scenario: 两台手机经中转输错 token

- **WHEN** 一台手机经中转连续输错 token 被限速
- **THEN** 另一台从不同 IP 经中转访问的手机不受影响

#### Scenario: 兄弟子域发起请求

- **WHEN** 同一中转域名下另一台电脑的页面向这台电脑发起带 Cookie 的写请求
- **THEN** Origin 不匹配，请求被拒绝

#### Scenario: 伪造转发头

- **WHEN** 经中转的请求带有 `x-forwarded-for: 127.0.0.1`
- **THEN** 该请求仍按非本机处理，限速按 Relay 告知的 IP 计数

### Requirement: 大传输不阻塞其他请求

Web 端每条中转流的接收窗口 SHALL 为 2 MiB，整条控制连接的接收窗口为 8 MiB。一台手机下载大文件时，经同一控制连接的其他手机连接 MUST 继续得到响应。

#### Scenario: 下载期间审批

- **WHEN** 一台手机正在经中转下载大文件，另一台手机发起审批
- **THEN** 审批请求及时得到处理

### Requirement: 界面不可被其他来源嵌入

所有入口返回的 HTML 页面 SHALL 带 `Content-Security-Policy: frame-ancestors 'self'`，使页面只能被同源页面嵌入。

#### Scenario: 兄弟子域嵌入界面

- **WHEN** 同一中转域名下另一台电脑的页面用 iframe 嵌入这台电脑的 Web
- **THEN** 浏览器拒绝显示，用户的登录状态不能被借用来诱导点击
