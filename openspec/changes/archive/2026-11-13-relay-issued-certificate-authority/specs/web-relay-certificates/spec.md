## MODIFIED Requirements

### Requirement: 自动申请证书

注册成功后，如果没有可用证书，Web SHALL 向中转下发的证书机构申请，使用 TLS-ALPN-01 验证；中转未下发时使用 Let's Encrypt 生产环境并直连。可用证书 MUST 同时满足：覆盖当前主机名、处于有效期内、与证书私钥匹配。ACME 账户私钥和证书私钥 MUST 在本机生成，MUST NOT 发送给 Relay 或其他任何一方。新证书 SHALL 立即用于手机连接，不重启 Web 或 Host。环境变量 `CODEXHOST_RELAY_ACME_DIRECTORY` 优先于下发的目录，并直连该目录。

#### Scenario: 首次开启中转

- **WHEN** 新电脑第一次注册成功
- **THEN** Web 向下发的证书机构申请证书，完成后手机可以经中转打开页面，Web 和 Host 都没有重启

#### Scenario: 身份密钥更换

- **WHEN** 用户删除身份密钥后重新开启，得到新的主机名
- **THEN** 旧证书和旧主机名的失败记录都不适用，Web 为新主机名申请证书

#### Scenario: 旧中转

- **WHEN** 中转没有下发证书机构
- **THEN** Web 直连 Let's Encrypt 生产环境申请，与之前相同

## ADDED Requirements

### Requirement: 经中转发出证书请求

中转下发了证书机构时，Web 的全部 ACME 请求 SHALL 经中转的证书请求通道发出，在通道内与证书机构建立 TLS 并校验其证书。用户配置了 HTTP 代理时，Web 先经该代理连到中转。该电脑在此证书机构还没有账户时，Web SHALL 向中转领取外部账户凭据并用于注册账户，凭据附带联系方式时一并提交，中转表示不提供时不带凭据注册；已有账户时 MUST NOT 领取。Web MUST NOT 提交用户的个人联系方式。

#### Scenario: 无法直连证书机构

- **WHEN** 电脑所在网络连不到 Google Trust Services，但能连到中转
- **THEN** 证书照常签发，用户不需要任何操作

#### Scenario: 已有账户

- **WHEN** 电脑此前已在 Google Trust Services 注册账户，到期续期
- **THEN** 续期不领取新的 EAB 凭据

#### Scenario: 中转暂时不能提供凭据

- **WHEN** 中转返回凭据暂时不可用或要求等待
- **THEN** 本轮申请按失败计入递增重试，下一次不早于中转要求的等待时间，不暂停自动申请

### Requirement: 跟随证书机构变更

收到中转的证书机构变更时，Web SHALL 作废进行中的申请并按新目录重新判断：仍可用且未到续期时间的证书继续使用，否则立即向新证书机构申请。失败记录按目录区分，新目录不沿用旧目录的退避和暂停。账户私钥和证书私钥不因切换而更换。

#### Scenario: 运营方切回 Let's Encrypt

- **WHEN** 一台新电脑向 Google Trust Services 的申请处于退避中，中转把证书机构切换为 Let's Encrypt
- **THEN** Web 立即向 Let's Encrypt 申请，不等待原退避时间

#### Scenario: 已有可用证书

- **WHEN** 电脑持有 Let's Encrypt 签发且未到续期时间的证书，中转切换为 Google Trust Services
- **THEN** 继续使用现有证书，到续期时间再向 Google Trust Services 申请
