# Tasks

## 1. 协议契约（主导者先提交，后续任务并行）

- [x] 1.1 在 `packages/remote-relay/src/protocol.ts` 增加 `paths.externalAccount`、`defaultCertificateDirectory`、注册响应 / 通知 / EAB 的类型。验证：`npx tsc -b packages/remote-relay/tsconfig.json`。

## 2. 中转核心（`packages/remote-relay`）

- [x] 2.1 注册响应下发目录与凭证，凭证随注册失效；`setCertificateDirectory` 通知在线电脑。验证：新增测试覆盖默认目录、切换后在线电脑收到通知且连接不断、替换注册后旧凭证失效。
- [x] 2.2 控制地址上的 CONNECT 通道与 `/v1/external-account`，先于 `onRequest`。验证：测试覆盖有效通道转发字节、错误目标 / 端口 / 凭证被拒、第 5 条通道 429、注册失效后通道关闭、切换后旧主机被拒、EAB 的 200/404/429/503/401、`onRequest` 收不到这两类请求。

## 3. 电脑端（`packages/web-server/src/remote-relay`）

- [x] 3.1 解析注册响应与变更通知，目录随注册设置，变更时作废进行中的轮次并重新判断。验证：单测覆盖目录优先级、退避中切换立即申请、已有可用证书切换后不重签。
- [x] 3.2 经中转通道发出 ACME 请求（含 `HTTPS_PROXY`），无账户时领取 EAB。验证：Pebble 测试（要求 EAB）经测试中转完成签发；直连 Pebble 被阻断时仍成功；已有账户续期不领取；429/503 计入退避不暂停。

## 4. 官方中转（官方中转的私有运营程序）

- [x] 4.1 `--gts-credentials` / `--gts-staging`、`certificate_authority` 设置与 `tick` 应用、GTS EAB 生成与按 ID 限流。验证：`npm test`，用假的令牌与 Public CA 服务覆盖令牌缓存、MAC 密钥转换、限流、设置为 `letsencrypt` 时不提供。
- [x] 4.2 管理页与 CLI 的证书机构选择。验证：页面测试覆盖保存、未配置凭据时禁用、CLI 拒绝非法值。

## 5. 文档与验收（主导者）

- [x] 5.1 更新 `docs/product/web-remote-access.md`、`docs/product/self-hosted-relay.md`、`packages/remote-relay/README.md`，以及私有仓库 `relay/README.md` 与 `relay/server/DESIGN.md`。验证：`openspec validate relay-issued-certificate-authority`。
- [x] 5.2 生产验收（替代原 staging 计划）：官方中转切换为 Google Trust Services，全新身份的电脑从注册、领取 EAB、经通道签发到手机访问完整通过。验收中发现 acme-client 生成的 TLS-ALPN 验证证书（CA 标志、零有效期）被 GTS 拒绝，改为自行生成叶子证书后通过。
