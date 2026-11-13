# Proposal

## Why

官方中转的所有电脑地址共用注册域名 `chost.dev`，Let's Encrypt 每 7 天只给这个域名约 50 张新证书（约每天 7 台新电脑），提额要等几周，赶不上上线。Google Trust Services（GTS）的额度按 GCP 项目计算，高出两个数量级，但中国大陆的电脑不开 VPN 时直连不到它的 ACME 接口。

## What Changes

- 中转决定电脑使用哪个证书机构：注册成功时下发 ACME 目录地址，运营方修改后通知在线电脑。默认仍是 Let's Encrypt 生产环境，自建中转不需要任何新配置。
- 中转在控制地址上为已注册电脑提供证书请求通道：电脑经中转建立到证书机构的 TCP 隧道，TLS 在电脑与证书机构之间端到端，中转只看到目标主机。目标只允许当前证书机构的主机。
- 证书机构要求外部账户绑定（EAB）时，电脑向中转按需领取一次性凭据；中转把生成凭据交给部署者提供的处理函数。
- 电脑端：连到支持以上能力的中转时，按下发的目录申请、所有 ACME 请求走通道、按需领取 EAB；证书机构变更时作废进行中的申请并按新目录重新判断。连到旧中转时行为不变。
- 官方中转（私有运营程序）：用 GCP 服务账号为电脑生成 GTS 的一次性 EAB，按身份限流；管理页“运行配置”增加证书机构选择（Let's Encrypt / Google Trust Services），保存后最迟 10 秒生效。

## Decisions

- **请求经中转发出，不让用户开 VPN，也不做电脑端自动回退。** 回退会把大陆用户送回 Let's Encrypt 的限额；产品不提示用户开 VPN。Let's Encrypt 只作为运营方手动切换的备用。
- **隧道而不是代发请求。** 中转只转发 TCP 字节，看不到也改不了 ACME 内容；账户私钥和证书私钥仍只在电脑上。
- **证书机构随注册下发、变更时推送，而不是每轮申请前查询。** 电脑在退避中也能立即得知切换，失败记录按目录区分的现有规则不变。
- **EAB 按需领取。** 只在证书机构要求且该电脑在此证书机构还没有账户时才领取，避免消耗配额。
- 不做 DNS-01、不做多域名分片、不改变证书私钥与账户私钥的存放位置。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `remote-relay`：新增证书机构下发与变更通知、证书请求通道、外部账户凭据领取。
- `web-relay-certificates`：证书机构由中转决定，申请请求经中转通道发出，支持 EAB，证书机构变更时的处理。

## Impact

- `packages/remote-relay`：协议常量与类型、注册响应、控制地址上的通道与凭据接口、运行时切换证书机构；README。
- `packages/web-server/src/remote-relay`：注册结果解析、证书机构跟随、经中转的 ACME 连接、EAB。
- 官方中转的私有运营程序：GTS 凭据生成、证书机构设置与管理页、部署文档与服务参数。
- 文档：`docs/product/web-remote-access.md`、`docs/product/self-hosted-relay.md`。
- 兼容：新电脑 + 旧中转、旧电脑 + 新中转都按原 Let's Encrypt 直连方式工作。
