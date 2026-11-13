# Design

## Context

- 中转核心 `packages/remote-relay`：中转是控制会话上的 HTTP/2 客户端，电脑是服务端（`registration.ts`）。中转可以随时向电脑发请求（`/v1/register`、`/v1/tcp`、`/v1/notice`），电脑不能在控制会话上主动发起双向流，所以电脑发起的通道必须另开一条到控制地址的连接。
- 注册响应目前只有 `{ hostname }`（`registration.ts` 的 `request.end(...)`）；`/v1/notice` 目前只有额度通知，电脑端解析 JSON 后只认 `quota === "exhausted"`，其他内容回 200 后忽略（`web-server/src/remote-relay/client.ts`）。
- 控制地址的 HTTPS 请求都交给部署者的 `onRequest`（官方中转的管理页）。核心目前没有监听 CONNECT。
- 电脑端 `Certificates` 在构造时固定目录（`acmeDirectory()`：环境变量或 Let's Encrypt 生产环境），失败记录按 `(hostname, directory)` 区分。`acme.ts` 用全局 `acme.axios`，已有请求和响应拦截器按轮次记录失败。`acme-client` 5.4.0 的 `Client` 支持 `externalAccountBinding`。
- 控制连接已支持经 `HTTPS_PROXY`（`http://`）的 CONNECT（`client.ts`）。
- 官方中转（私有仓库 `codexhost-cloud/relay/server`）：`runtime.mjs` 用 `createRelay` 组合运营数据库；配置存在 `settings` 表，每 10 秒一次 `tick`；管理页“运行配置”统一保存。控制地址证书由 certbot 提供（`--cert/--key`）。官方电脑地址为 `<名>.r.chost.dev`。

## Decisions

### 协议（`@codexhost/remote-relay/protocol`，先单独提交，作为并行开发的契约）

- 注册响应：`{ hostname: string; token: string; certificateAuthority: { directory: string } }`。`token` 为 32 字节随机数的 base64url，只在本次注册有效。旧电脑忽略新字段。
- 变更通知：中转向在线电脑 `POST /v1/notice`，正文 `{ certificateAuthority: { directory } }`。旧电脑按现有逻辑忽略。
- 外部账户凭据：电脑向控制地址 `POST /v1/external-account`，`Authorization: Bearer <token>`，无正文。
  - 200 `{ keyId: string; hmacKey: string }`（hmacKey 为 base64url）；
  - 404 不提供（未配置处理函数，或当前证书机构不需要）；
  - 429 带 `Retry-After`（秒）；503 暂时不可用；401 凭证无效。
- 证书请求通道：电脑向控制地址发 `CONNECT <证书机构主机>:443`，`Proxy-Authorization: Bearer <token>`。
  - 200 建立；407 凭证无效；403 目标不是当前目录的主机或端口不是 443；429 该凭证已有 4 条通道；502 连不上目标。
  - 目标只比对当前目录 URL 的主机名，不解析目录内容。Let's Encrypt 和 GTS 的全部 ACME 接口与目录同主机；若证书机构跳到其他主机，请求会被拒绝并表现为申请失败。
- 导出常量 `defaultCertificateDirectory`（Let's Encrypt 生产目录）及上述类型；`paths.externalAccount = "/v1/external-account"`。

### 中转核心

- `RelayOptions` 增加：
  - `certificateDirectory?: string`：初始目录，默认 `defaultCertificateDirectory`；
  - `externalAccount?: (request: { id: string; name: string }) => Promise<ExternalAccount | { retryAfter?: number } | undefined>`：返回凭据；返回 `undefined` 表示不提供；返回 `{ retryAfter }` 表示稍后再试（无 `retryAfter` 时为 503）；抛错按 503 处理。
- `createRelay` 返回值增加 `setCertificateDirectory(directory: string)`：只接受 `https:` URL；与当前值相同则不做事；否则更新并向所有在线电脑发变更通知。
- 凭证与注册一一对应：注册成功时生成，注册失效（替换、断开、心跳超时）时删除。通道和凭据接口都先查凭证对应的仍在线的注册。
- CONNECT 在控制地址的 HTTP 服务上处理（Node `connect` 事件），先于 `onRequest`；`/v1/external-account` 同样先于 `onRequest`。连接目标 10 秒超时；双向 60 秒无数据关闭；注册失效时关闭该凭证的全部通道。通道不经过 `Usage`，不触发 `onUsage`/`onConnection`。
- 自建 CLI 不加新参数：总是提供通道，目录为 Let's Encrypt，没有 EAB。

### 电脑端

- 目录优先级：`CODEXHOST_RELAY_ACME_DIRECTORY`（直连）> 注册下发的目录（经通道）> Let's Encrypt 生产环境（直连，旧中转）。
- `Certificates` 的目录改为随注册设置；收到变更且目录不同时：作废进行中的轮次，按新目录重新 `check()`。失败记录规则不变（目录不同即不适用）。
- 经通道时，每轮建一个 HTTPS Agent：先连控制地址（有 `HTTPS_PROXY` 时先经代理 CONNECT，复用控制连接的做法），TLS（servername 为控制地址）后发 CONNECT，再在其上与证书机构做 TLS，正常校验证书。Agent 只属于本轮，轮次结束时销毁；请求拦截器为本轮请求设置该 Agent。
- 账户：仍先 `onlyReturnExisting` 查询；不存在且有凭证时向中转领取 EAB，200 则带 EAB 创建账户，404 则不带。429/503 作为本轮失败，`Retry-After` 计入记录的 `retryAfter`；不计为验证失败，不暂停。
- 不新增持久化文件，不改账户私钥和证书私钥的位置。

### 官方中转（`codexhost-cloud`）

- 启动参数：`--gts-credentials <服务账号 JSON 路径>`；`--gts-staging`（只用于测试部署，使用 GTS staging 目录 `https://dv.acme-v02.test-api.pki.goog/directory` 和 `preprod-publicca.googleapis.com`）。生产 GTS 目录 `https://dv.acme-v02.api.pki.goog/directory`。
- 设置 `certificate_authority`：`letsencrypt`（默认）| `gts`。没有 `--gts-credentials` 时不能设为 `gts`（管理页禁用该选项，CLI 报错）。启动时用当前值作为 `certificateDirectory`；`tick` 发现变化时调用 `setCertificateDirectory`，最迟 10 秒生效。
- EAB：用服务账号签 JWT 换取访问令牌（缓存到过期前），调用 Public CA `externalAccountKeys.create`，把返回的 MAC 密钥转为 base64url。当前设置不是 `gts` 时返回 `undefined`。不新增依赖，使用 Node 内置 `crypto` 与 `fetch`。
- 限流：同一电脑 ID 每 24 小时最多 3 份凭据（内存，重启清空），超出返回 `{ retryAfter }`。日志只记 ID、地址名与结果，不记凭据。
- 管理页“运行配置”增加“证书机构”分组，随“保存配置”一起提交；文案见任务文件。

## Risks / Trade-offs

- [控制地址成为签发的必经点] → 签发本来就依赖中转转发 TLS-ALPN-01 验证，不新增依赖方；中转只看到目标主机和时间。
- [中转被当作开放代理] → 只接受有效凭证、只允许当前证书机构主机的 443，单凭证最多 4 条。
- [EAB 被已注册用户刷配额] → 每 ID 每 24 小时 3 份；电脑只在没有账户时领取；GCP 配额是总上限。
- [`onlyReturnExisting` 查询可能占用 GTS 的新账户配额] → staging 验收时确认；如占用，再考虑在本机记录账户 URL。
- [GCP 项目被停用] → 已签发证书不受影响；运营方在管理页切回 Let's Encrypt，在线电脑立即跟随。
- [staging 目录被下发给真实用户] → `--gts-staging` 只在测试部署使用，写入运营文档。

## Migration

- 发布顺序：中转核心与官方中转先上线（旧电脑不受影响，默认仍为 Let's Encrypt）→ 发布新客户端 → GCP 就绪并完成 staging 验收后，在管理页切换为 Google Trust Services。
- 回滚：管理页切回 Let's Encrypt；中转程序回滚到旧版本时，新电脑看不到下发字段，自动回到直连 Let's Encrypt。

## Open Questions

- GTS 的 `onlyReturnExisting` 是否计入新账户配额、限流时是否返回 `Retry-After`：staging 验收时确认，不影响协议。
