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
- codexhost 只添加自己的路径映射 `/codexhost`，关闭时只删除这一条；启动时核对映射是否仍指向当前端口，并修正指向 codexhost 端口的过期条目。
- tailnet 地址变化（重新登录、切换 tailnet）时重新绑定；不可用时只影响该入口。

### 4. OAuth 只服务公网入口

实现 MCP 授权规范所需的最小集合：受保护资源元数据、授权服务器元数据、动态客户端注册、授权码 + PKCE、刷新令牌。授权页由 Runtime 在公网路径下提供，只有一个配对码输入框。配对码由本机 CLI 生成，与客户端绑定，因此“谁授权给谁”始终由本机用户决定。访问令牌有效期 1 小时，刷新令牌 30 天，均以哈希形式保存。如果前置验证表明 Grok Bot 支持静态 Bearer header，OAuth 仍保留给 ChatGPT、Claude 等只支持 OAuth 的托管 connector，但不阻塞 Grok Bot 的接入。

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

## Risks / Trade-offs

- [公网入口暴露可驱动本机 agent 的接口] → 默认关闭、按客户端开放、OAuth 授权需本机配对码、可随时吊销；控制台显示每个客户端最近一次访问的入口与时间。
- [当前用户在使用中全程 bypass 权限] → agent 本身的权限不在本提案范围内，本提案只保证“谁能派发”可控、可撤销。
- [Funnel 配置与用户的其他配置冲突] → 只管理自己的路径；路径已被其他服务占用时报错，不覆盖。
- [厂商 webhook 格式变化] → 收在 adapter 内，失败分类为 `drop` 时在控制台显示，事件日志仍可兜底。

## Migration

已有客户端在首次启动时补齐 `dispatch` + `local` 范围。回滚到上一版本时，范围字段与 webhook 配置被忽略，tailnet 与公网入口随之消失，Funnel 映射需要用户手动删除；控制台在关闭公网访问时会自动删除映射，所以回滚前先关闭公网访问即可。

## Open Questions

- Grok Bot 自定义 MCP connector 的认证方式，以及 webhook 触发器的 URL 形式、payload 与签名要求，待前置验证（tasks 0.1、0.2）。
