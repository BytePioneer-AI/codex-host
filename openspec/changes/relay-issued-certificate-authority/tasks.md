# Tasks

## 1. 协议契约（主导者先提交，后续任务并行）

- [ ] 1.1 在 `packages/remote-relay/src/protocol.ts` 增加 `paths.externalAccount`、`defaultCertificateDirectory`、注册响应 / 通知 / EAB 的类型。验证：`npx tsc -b packages/remote-relay/tsconfig.json`。

## 2. 中转核心（`packages/remote-relay`）

- [ ] 2.1 注册响应下发目录与凭证，凭证随注册失效；`setCertificateDirectory` 通知在线电脑。验证：新增测试覆盖默认目录、切换后在线电脑收到通知且连接不断、替换注册后旧凭证失效。
- [ ] 2.2 控制地址上的 CONNECT 通道与 `/v1/external-account`，先于 `onRequest`。验证：测试覆盖有效通道转发字节、错误目标 / 端口 / 凭证被拒、第 5 条通道 429、注册失效后通道关闭、切换后旧主机被拒、EAB 的 200/404/429/503/401、`onRequest` 收不到这两类请求。

## 3. 电脑端（`packages/web-server/src/remote-relay`）

- [ ] 3.1 解析注册响应与变更通知，目录随注册设置，变更时作废进行中的轮次并重新判断。验证：单测覆盖目录优先级、退避中切换立即申请、已有可用证书切换后不重签。
- [ ] 3.2 经中转通道发出 ACME 请求（含 `HTTPS_PROXY`），无账户时领取 EAB。验证：Pebble 测试（要求 EAB）经测试中转完成签发；直连 Pebble 被阻断时仍成功；已有账户续期不领取；429/503 计入退避不暂停。

## 4. 官方中转（私有仓库 `codexhost-cloud/relay/server`）

- [ ] 4.1 `--gts-credentials` / `--gts-staging`、`certificate_authority` 设置与 `tick` 应用、GTS EAB 生成与按 ID 限流。验证：`npm test`，用假的令牌与 Public CA 服务覆盖令牌缓存、MAC 密钥转换、限流、设置为 `letsencrypt` 时不提供。
- [ ] 4.2 管理页与 CLI 的证书机构选择。验证：页面测试覆盖保存、未配置凭据时禁用、CLI 拒绝非法值。

## 5. 文档与验收（主导者）

- [ ] 5.1 更新 `docs/product/web-remote-access.md`、`docs/product/self-hosted-relay.md`、`packages/remote-relay/README.md`，以及私有仓库 `relay/README.md` 与 `relay/server/DESIGN.md`。验证：`openspec validate relay-issued-certificate-authority`。
- [ ] 5.2 本地测试中转（`--gts-staging`）+ 新客户端，对 GTS staging 完成一次真实签发与一次切换到 Let's Encrypt staging；记录 `onlyReturnExisting` 与限流的实际表现。验证：签发成功的证书链为 GTS staging。
