# Spec Delta

## Purpose

Relay 让没有公网地址的电脑通过 `<id>.<域名>` 被手机浏览器访问。它只按 SNI 转发加密字节，不解开用户 TLS，官方中转和自托管中转使用同一份程序。

## ADDED Requirements

### Requirement: 子域 ID 由公钥决定

每台电脑的子域 ID MUST 只由其身份公钥确定：同一公钥总得到同一 ID，不同公钥得到不同 ID 的概率可以忽略。ID MUST 是合法的 DNS 标签，只含小写字母和数字。Relay MUST 自己从公钥计算 ID，不接受电脑声明的 ID 或主机名。用户访问地址为 `<id>.<域名>`。

#### Scenario: 换网络后地址不变

- **WHEN** 电脑更换 IP 后用同一身份密钥重新注册
- **THEN** Relay 计算出相同的 ID，手机仍用原地址访问

#### Scenario: 不能注册别人的子域

- **WHEN** 一个客户端不持有某 ID 对应的私钥，尝试注册该 ID
- **THEN** 注册失败，该 ID 的现有注册不受影响

### Requirement: 电脑注册

电脑 MUST 通过 WSS 连接 Relay 控制地址上带协议版本的路径来注册。Relay 发出随机挑战，电脑用身份私钥签名，签名内容 MUST 绑定挑战和控制地址。验证通过后 Relay 告知电脑其完整主机名，之后该 ID 的手机连接才会被转发。不支持的协议版本、超时或签名无效时，Relay MUST 关闭连接，并让电脑能区分原因。

#### Scenario: 注册成功

- **WHEN** 电脑完成 WSS 连接并返回有效签名
- **THEN** Relay 返回 `<id>.<域名>`，此后发往该主机名的手机连接被转发到这台电脑

#### Scenario: 签名转发到其他 Relay 无效

- **WHEN** 恶意 Relay 把电脑对它的签名拿到另一个控制地址注册
- **THEN** 另一个 Relay 验证失败，拒绝注册

#### Scenario: 协议版本不支持

- **WHEN** 电脑请求 Relay 不支持的协议版本路径
- **THEN** Relay 拒绝升级为 WebSocket，电脑可据此提示升级，不必反复重试

#### Scenario: 注册超时

- **WHEN** 连接建立后 10 秒内没有完成注册
- **THEN** Relay 关闭该连接

### Requirement: 新注册替换旧注册

同一 ID 在任何时刻 MUST 只有一条生效的控制连接。同一 ID 的新注册成功后，Relay MUST 关闭旧控制连接以及经它转发的手机连接，并告知旧连接被替换。

#### Scenario: 断线后旧连接尚未超时

- **WHEN** 电脑网络切换后重新注册，而 Relay 还没发现旧连接已断
- **THEN** 新连接立即生效，旧连接被关闭，新的手机连接都走新连接

### Requirement: 控制连接心跳

Relay MUST 每 25 秒在每条控制连接上发送一次心跳。上一次心跳在下一次发送时仍未收到回应，Relay MUST 关闭该控制连接并注销该 ID，最迟约 50 秒内发现静默断开的电脑。

#### Scenario: 电脑休眠

- **WHEN** 电脑休眠，控制连接没有收到 FIN
- **THEN** Relay 在两个心跳周期内注销该 ID，之后到该地址的手机连接被关闭

### Requirement: 按 SNI 转发且不解开 TLS

Relay MUST 在 443 端口接受手机 TCP 连接，读取 TLS ClientHello 的 SNI 后，把包括 ClientHello 在内的全部字节原样交给对应电脑，不解开 TLS，不修改内容。ClientHello 可能跨多个 TCP 分段或 TLS 记录；超过 16 KiB 或 10 秒仍未读完、没有 SNI、SNI 不是控制地址也不属于在线 ID 时，Relay MUST 直接关闭连接。

#### Scenario: 电脑在线

- **WHEN** 手机访问 `https://<id>.<域名>`，该 ID 已注册
- **THEN** 手机与电脑完成 TLS 握手，证书由电脑提供，Relay 看不到 HTTP 内容

#### Scenario: 电脑离线或地址未知

- **WHEN** SNI 对应的 ID 未注册，或 SNI 不属于该 Relay 的域名
- **THEN** Relay 关闭连接，不返回任何内容

#### Scenario: 慢速发送 ClientHello

- **WHEN** 客户端连接后 10 秒内没有发完 ClientHello
- **THEN** Relay 关闭连接

### Requirement: Relay 不保存内容

Relay MUST NOT 把转发的字节写入磁盘或日志。日志只能包含元数据：ID、电脑和手机的 IP、连接时间、字节数和关闭原因。

#### Scenario: 检查日志

- **WHEN** 手机经 Relay 完成登录和日常操作
- **THEN** Relay 的输出和磁盘上找不到请求或响应内容

### Requirement: 每条手机连接一个流

Relay MUST 为每条手机连接在对应控制连接上打开一个独立的流，并随流告知电脑手机的 IP 和端口。两个方向的结束 MUST 独立传递：一方发送完毕不影响另一方继续发送；任一方异常中断时，另一方也被中断。每个 ID 同时转发的手机连接 MUST 不超过 32 条，超出的新连接被关闭。

#### Scenario: 传递客户端地址

- **WHEN** 手机从某 IP 建立连接
- **THEN** 电脑在该流上拿到这个 IP 和端口，可用于登录限速

#### Scenario: 半关闭

- **WHEN** 手机发送完请求并关闭写方向，电脑还在发送响应
- **THEN** 电脑的响应完整送达手机

### Requirement: 流控与背压

Relay MUST 让每个流的接收窗口为 2 MiB、每条控制连接的接收窗口为 8 MiB。手机接收慢时，Relay MUST 停止读取对应流，而不是无限缓存，每台电脑每个方向的缓存因此不超过约 64 MiB。一条手机连接传输大文件时，同一电脑的其他手机连接 MUST 继续得到转发。

#### Scenario: 手机网络慢

- **WHEN** 电脑向一台网络很慢的手机发送大文件
- **THEN** Relay 为这条连接缓存的未发送数据不超过 2 MiB，电脑在这条连接上的发送被阻塞

#### Scenario: 多台手机同时很慢

- **WHEN** 同一电脑的多条手机连接同时接收很慢，另有一条连接在正常交互
- **THEN** 每条慢连接的缓存不超过 2 MiB，正常交互的连接继续得到转发

#### Scenario: 大传输期间审批

- **WHEN** 一条手机连接正在下载大文件，同一电脑上另一条连接发起审批请求
- **THEN** 审批请求被及时转发，不等大文件传完

### Requirement: 按子域限速和每日额度

Relay MUST 支持按 ID 配置每个方向的带宽上限和每日总字节额度，未配置时不限制。每日额度按 UTC 日计算，同一 ID 重连不清零。超出当日额度后，Relay MUST 关闭该 ID 的现有手机连接并拒绝新连接，直到次日。超额期间 ALPN 只含 `acme-tls/1` 的连接仍被转发，但每条不超过 64 KiB、10 秒，且每个 ID 每小时合计不超过 1 MiB。

#### Scenario: 超过每日额度

- **WHEN** 某 ID 当日转发字节数达到额度
- **THEN** 该 ID 的手机连接被关闭，新连接被拒绝，其他 ID 不受影响

#### Scenario: 超额时续期证书

- **WHEN** 某 ID 已超额，证书机构发起 TLS-ALPN-01 验证
- **THEN** 验证连接被转发，电脑可以完成续期

#### Scenario: 冒充验证连接

- **WHEN** 超额期间客户端只声明 `acme-tls/1`，反复建立小连接传输数据
- **THEN** 单条连接在 64 KiB 或 10 秒处被关闭，该 ID 一小时内累计达到 1 MiB 后新的验证连接被拒绝

### Requirement: 部署配置

Relay MUST 由部署者提供域名、控制地址（默认与域名相同）以及控制地址的证书和私钥，Relay 只为控制地址终止 TLS。收到重新加载信号时，Relay MUST 重新读取控制地址证书，不中断已有连接。

#### Scenario: 控制地址证书续期

- **WHEN** 部署者更新证书文件并发送重新加载信号
- **THEN** 新的控制连接使用新证书，已注册的电脑和转发中的连接不受影响
