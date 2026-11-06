# Design

## Context

本设计服务于 [proposal](proposal.md)。它把外部监听开放到本机之外，涉及安全边界、认证协议、对第三方服务的推送和对 Tailscale 配置的修改，因此单独写出。前提是 `add-external-client-access` 已提供客户端登记、外部监听、事件日志和 MCP。

## Decisions

### 1. 三个入口，一套处理

```text
127.0.0.1:4398              ─┐
<tailscale 地址>:4398 (HTTP) ─┼─▶ 范围检查 ─▶ 外部 API / MCP / 事件（同一实现）
Funnel :443 /codexhost/*     ─┘    （客户端令牌或 OAuth 访问令牌 → 客户端）
```

请求的“网络”由入口决定，不看请求头：本机入口是 `local`，Tailscale 地址入口是 `tailnet`，Funnel 转发到的专用本机端口是 `public`。Funnel 转发到一个只服务公网路径的独立 loopback 端口，因此本机进程无法冒充 `local` 之外的入口，公网请求也无法伪装成 `local`。

### 2. 权限范围的划分

只设 `read` / `dispatch` 两档，对应“看”和“让 agent 干活”。更细的能力（例如禁止合并、按仓库白名单）依赖对 Harness 内部行为的约束，Host 层做不到可靠拦截，留给后续提案，并配合 Git 托管侧的分支保护。

### 3. Tailscale 集成

- 地址发现与 Funnel 都通过本机 `tailscale` CLI 的 JSON 输出与 `serve`/`funnel` 子命令完成，不链接 Tailscale 库。
- codexhost 只添加自己的路径映射，关闭时只删除这些条目；启动时核对映射是否仍指向当前端口，并修正指向 codexhost 端口的过期条目。
- `tailscale funnel --set-path <前缀>` 会剥离前缀，后端收到的是去掉前缀后的路径。公网 loopback 端口因此按“去前缀后的路径”路由，不依赖前缀。
- OAuth 发现请求打在根路径的 `/.well-known/...` 下。codexhost 只额外映射以自身路径为后缀的发现地址（`/.well-known/oauth-protected-resource/codexhost/mcp` 与 `/.well-known/oauth-authorization-server/codexhost`，按 RFC 9728 / RFC 8414 的路径插入规则），不占用整个根路径。tailscale serve 能否把这些路径转发到后端的指定路径，在实现时验证；不能时退回为每个发现路径使用独立的 loopback 端口。
- 首次开启 Funnel 时证书签发约需 1 分钟，其间 TLS 握手失败；控制台显示“证书签发中”，不判定为失败。
- tailnet 地址变化（重新登录、切换 tailnet）时重新绑定；不可用时只影响该入口。

### 4. OAuth 只服务公网入口

实现 MCP 授权规范所需的最小集合：受保护资源元数据、授权服务器元数据、动态客户端注册、授权码 + PKCE、刷新令牌。授权页由 Runtime 在公网路径下提供，只有一个配对码输入框。配对码由本机 CLI 生成，与客户端绑定，因此“谁授权给谁”始终由本机用户决定。访问令牌有效期 1 小时，刷新令牌 30 天，均以哈希形式保存。

前置验证（2026-11-03）表明：Grok Bot 的自定义 connector 既可以配置静态 `headers`，也支持标准 MCP OAuth（动态客户端注册，或预注册的 client id）；客户端只在收到 401 后才开始发现流程。因此：

- **Grok Bot 先用静态 Bearer 客户端令牌接入**，不依赖 OAuth，PR 可以先交付范围、监听与 webhook。
- 公网入口对未认证请求返回 `401` + `WWW-Authenticate: Bearer resource_metadata="…"`，供需要 OAuth 的 connector（ChatGPT、Claude 等）走发现流程。
- OAuth 支持 DCR（`/register`），不另做预注册 client 管理。

公网调用方来自轮换的云端出口 IP，会频繁重建 MCP 会话（多次 initialize / `DELETE /mcp`、并发 SSE 流）。认证只看令牌，不做来源 IP 白名单；MCP 会话层容忍频繁重建，同一客户端的第二条 SSE 流不报错。

### 5. webhook adapter

adapter 是 Host 内的小模块，接口为：

```ts
interface WebhookAdapter {
  id: string;                        // "grok-bot"
  validateConfig(config: unknown): void;
  buildRequest(event: ClientEvent, config): { url; headers; body };
  classify(response): "delivered" | "retry" | "drop";
}
```

投递状态（最后确认的事件标识、每条事件的重试计数和下次时间）按客户端持久化，与 PR 1 的 watch 持久化放在同一个私有状态目录。退避从 5 秒起每次翻倍，上限 15 分钟，总期限 24 小时。webhook 只做唤醒，payload 只含事件字段；bot 被唤醒后通过 MCP `thread_read` 获取结果。

首个 adapter 依据前置验证的结果（Grok Bot 的 webhook 触发器建在 Cursor Automations 上，地址形如 `https://api2.cursor.sh/automations/webhook/<uuid>`）：

| 项 | 行为 |
| --- | --- |
| 认证 | `Authorization: Bearer <key>`；key 由用户配置，按客户端仅当前用户可读保存，不出现在日志与控制台 |
| 签名 | 目标不校验签名，adapter 不签名 |
| body | `application/json`，只含事件标识、Thread、结果、Harness、深度链接与引用，上限 4 KB（目标只向 bot 展示前几 KB）|
| 幂等 | 目标不去重；adapter 以 `Idempotency-Key: <客户端>:<事件标识>` 透传事件标识，供 bot 自行去重 |
| 分类 | 2xx 为已投递（目标只表示已排队）；401/403/400 为 `drop` 并在控制台提示配置错误；429、5xx、超时为 `retry` |

adapter 标识用 `grok-bot`，实现上只依赖这个 webhook 契约。

## Risks / Trade-offs

- [公网入口暴露可驱动本机 agent 的接口] → 默认关闭、按客户端开放、OAuth 授权需本机配对码、可随时吊销；控制台显示每个客户端最近一次访问的入口与时间。
- [当前用户在使用中全程 bypass 权限] → agent 本身的权限不在本提案范围内，本提案只保证“谁能派发”可控、可撤销。
- [Funnel 配置与用户的其他配置冲突] → 只管理自己的路径；路径已被其他服务占用时报错，不覆盖。
- [厂商 webhook 格式变化] → 收在 adapter 内，失败分类为 `drop` 时在控制台显示，事件日志仍可兜底。

## Migration

已有客户端在首次启动时补齐 `dispatch` + `local` 范围。回滚到上一版本时，范围字段与 webhook 配置被忽略，tailnet 与公网入口随之消失，Funnel 映射需要用户手动删除；控制台在关闭公网访问时会自动删除映射，所以回滚前先关闭公网访问即可。

## Open Questions

- tailscale serve 能否把 `/.well-known/...` 下的指定路径转发到后端的指定路径（见决策 3）。
- Grok Bot 走 OAuth 时实际请求的端点序列：前置验证中测试服务不返回 401，客户端未发起发现；在实现 OAuth 后用真实 Grok Bot 复测。
