## ADDED Requirements

### Requirement: 下发证书机构

Relay SHALL 在注册成功的响应中告知电脑当前证书机构的 ACME 目录地址，以及一个只属于本次注册的随机凭证，用于下述通道和凭据接口。未配置时目录为 Let's Encrypt 生产环境。部署者 MAY 在运行中更换目录；更换后 Relay MUST 立即通知所有在线电脑，不断开连接。注册被替换或断开后，旧凭证 MUST 立即失效。

#### Scenario: 默认配置

- **WHEN** 自建中转没有配置证书机构，电脑注册成功
- **THEN** 电脑收到 Let's Encrypt 生产目录和本次注册的凭证

#### Scenario: 运营方切换证书机构

- **WHEN** 部署者把目录从 Google Trust Services 改为 Let's Encrypt
- **THEN** 在线电脑收到新目录，控制连接和手机连接不中断；之后注册的电脑直接收到新目录

#### Scenario: 旧电脑

- **WHEN** 不认识新字段的旧电脑注册或收到变更通知
- **THEN** 注册照常成功，通知被忽略，旧电脑继续直连 Let's Encrypt

### Requirement: 证书请求通道

Relay SHALL 在控制地址上接受携带有效注册凭证的 HTTP CONNECT 请求，目标 MUST 是当前证书机构目录地址的主机和端口（未写端口时为 443），其他目标拒绝。Relay 只转发字节，MUST NOT 解开其中的 TLS 或记录内容。每个凭证同时最多 4 条通道，空闲 60 秒或注册失效时关闭。通道流量不计入地址的带宽限制和每日额度。

#### Scenario: 经中转访问证书机构

- **WHEN** 已注册电脑带凭证请求连接当前证书机构的主机
- **THEN** Relay 建立通道，电脑在通道内与证书机构完成 TLS 并校验其证书

#### Scenario: 拒绝其他目标

- **WHEN** 请求的目标与当前目录地址的主机或端口不符，或凭证无效、已失效
- **THEN** Relay 拒绝请求，不连接目标

#### Scenario: 证书机构已切换

- **WHEN** 证书机构切换后，电脑仍请求连接旧证书机构的主机
- **THEN** 新通道被拒绝

### Requirement: 外部账户凭据

部署者 MAY 提供一个生成外部账户绑定（EAB）凭据的处理函数。电脑带有效注册凭证请求时，Relay SHALL 以该电脑的 ID 和地址名调用它，并把返回的密钥标识与 HMAC 密钥交给电脑。没有处理函数或它表示当前证书机构不需要时，Relay MUST 返回“不提供”；处理函数要求稍后再试或失败时，Relay MUST 分别告知电脑等待时间或暂时不可用。凭据不写日志。

#### Scenario: 领取凭据

- **WHEN** 官方中转使用 Google Trust Services，已注册电脑请求 EAB
- **THEN** 电脑收到一次性凭据，Relay 日志中没有凭据内容

#### Scenario: 自建中转

- **WHEN** 部署者没有提供处理函数，电脑请求 EAB
- **THEN** Relay 返回“不提供”

## MODIFIED Requirements

### Requirement: 控制地址上的其他请求

部署者 MAY 提供一个 HTTP 请求处理函数。控制地址上不属于 Relay 协议的 HTTPS 请求（不是升级到注册路径的 WebSocket 请求，也不是证书请求通道和外部账户凭据请求）MUST 交给它处理；没有提供时，Relay 对这些请求返回 404。手机发往地址名的连接不受影响，仍按 SNI 原样转发。

#### Scenario: 部署者处理自定义路径

- **WHEN** 部署者提供了处理函数，浏览器访问控制地址上由部署者自定的路径
- **THEN** 请求交给该处理函数，由它返回页面

#### Scenario: 没有提供处理函数

- **WHEN** 部署者没有提供处理函数，浏览器访问控制地址上的任意路径
- **THEN** Relay 返回 404

#### Scenario: 协议请求不交给处理函数

- **WHEN** 部署者提供了处理函数，电脑发起证书请求通道或外部账户凭据请求
- **THEN** 请求由 Relay 处理，处理函数不会收到
