# Spec Delta

## MODIFIED Requirements

### Requirement: 在电脑上解开 TLS

每条经 Relay 到达的手机连接 SHALL 在 Web 进程内用数据目录中的证书完成 TLS，只协商 HTTP/1.1，再交给现有 HTTP 服务；10 秒内未完成握手的连接 MUST 被关闭。Web MUST NOT 为此新开监听端口。ALPN 只含 `acme-tls/1`、SNI 与正在申请的主机名相同（不区分大小写）时，Web SHALL 用挑战证书应答，最低 TLS 1.2，握手后关闭；挑战证书在本次申请结束前对每次连接都有效。其他 `acme-tls/1` 连接直接关闭。没有可用证书时，Web SHALL 保持注册，把其余手机连接直接关闭。Web MUST NOT 通过 Alt-Svc 或其他方式宣告 HTTP/3 或 ECH。

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
- **THEN** Web 用该主机名的挑战证书完成握手，即使还没有正式证书；证书机构从多个地点同时连接时每次都能完成

#### Scenario: 没有申请时的验证连接

- **WHEN** 没有进行中的申请，收到 ALPN 为 `acme-tls/1` 的连接
- **THEN** Web 直接关闭该连接

### Requirement: 连接与注册

开启后 Web SHALL 通过 443 端口的出站 WSS 连接控制地址，按 Relay 协议完成注册并记录 Relay 返回的地址。一次连接尝试超过 30 秒未完成注册即放弃并按重连规则重试。环境变量 `HTTPS_PROXY` 指向 HTTP 代理时 MUST 经该代理连接。连接设备页 SHALL 按手机能否访问显示状态：关闭；准备中（连接、注册和首次申请证书）；已开启（附地址）；暂时无法使用（附自动重试时间）；需要处理（证书申请暂停，附证书机构的说明）；已停止（附原因）。准备中时页面 SHALL 自动刷新直到状态稳定。证书有效期、续期和申请过程 MUST NOT 作为单独状态显示。

#### Scenario: 注册成功

- **WHEN** 电脑能访问 Relay，注册通过，证书有效
- **THEN** 连接设备页显示已开启和 `https://<id>.<域名>`，不显示证书有效期

#### Scenario: 经代理连接

- **WHEN** 电脑只能通过 HTTP 代理访问外网，`HTTPS_PROXY` 已设置
- **THEN** Web 经代理连上 Relay 并完成注册

#### Scenario: 证书申请失败

- **WHEN** 已注册但证书申请失败
- **THEN** 连接设备页显示暂时无法使用和下次重试时间；申请已暂停时显示需要处理和证书机构的说明
