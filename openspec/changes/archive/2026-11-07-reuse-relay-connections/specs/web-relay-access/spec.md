## MODIFIED Requirements

### Requirement: 在电脑上解开 TLS

每条经 Relay 到达的手机连接 SHALL 在 Web 进程内用数据目录中的证书完成 TLS，优先协商 HTTP/2 并兼容 HTTP/1.1，共用现有请求处理；10 秒内未完成握手的连接 MUST 被关闭。Web MUST NOT 新开监听端口。ALPN 只含 `acme-tls/1` 且 SNI 与申请主机名相同（不区分大小写）时，Web SHALL 用挑战证书应答，最低 TLS 1.2，握手后关闭，申请期间每次验证均有效。其他验证连接直接关闭。没有可用证书时 SHALL 保持注册并关闭普通手机连接。Web MUST NOT 宣告 HTTP/3 或 ECH。

#### Scenario: 手机经中转打开页面

- **WHEN** 证书有效，手机访问 `https://<id>.<域名>`
- **THEN** 手机看到的证书由这台电脑提供，页面、登录、RPC 和 WebSocket 都与其他入口一致

#### Scenario: 握手停滞

- **WHEN** 客户端发完 ClientHello 后不再发送
- **THEN** 10 秒后该连接被关闭

#### Scenario: 还没有证书

- **WHEN** 已注册但数据目录中没有证书
- **THEN** 手机连接被关闭，连接设备页显示准备中或暂时无法使用

#### Scenario: 证书机构验证

- **WHEN** 申请进行中，证书机构经 Relay 发起 ALPN 为 `acme-tls/1` 的连接
- **THEN** Web 用该主机名的挑战证书完成握手，即使还没有正式证书；多地点同时连接时每次都能完成

#### Scenario: 没有申请时的验证连接

- **WHEN** 没有进行中的申请，收到 ALPN 为 `acme-tls/1` 的连接
- **THEN** Web 直接关闭该连接

#### Scenario: HTTP/2 多路复用

- **WHEN** 手机支持 HTTP/2 并发起多个 HTTP 请求
- **THEN** 经中转协商 h2，在同一 TLS 连接上并发处理，认证和中转归属不变

#### Scenario: WebSocket 和旧客户端

- **WHEN** 浏览器打开 WebSocket，或客户端只支持 HTTP/1.1
- **THEN** 经独立 HTTP/1.1 连接使用现有认证与升级处理，不要求 HTTP/2 扩展 CONNECT

#### Scenario: 其他入口不变

- **WHEN** 通过 localhost、局域网、Tailscale 或反向代理连接 Web 的 HTTP 端口
- **THEN** Web 仍使用 HTTP/1.1
