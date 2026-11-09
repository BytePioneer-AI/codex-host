# Design

## Context

Web 能只读检测 Serve 地址（`tailscale serve status --json`），并有 `RequestTrust`（启动时固定的可信代理集合）、本机访问判断和连接设备页。会话页的 `HostConnectionStatus` 已显示 `offline`、`checking`、`reconnecting`、`host` 和 `error`；`watchAuthentication` 在重连时探测 `/api/auth/status`，401 进入带“登录已失效”提示的登录页；Host 断开通过 `nativeConnection` 投影到打开的会话。

已对照 Tailscale v1.104.1 源码确认，Serve 反向代理保留原始 `Host`，并用覆盖方式写入 `X-Forwarded-Host`、`X-Forwarded-Proto: https` 和 `X-Forwarded-For`（请求方的 tailnet 地址），客户端无法伪造。

## Decisions

**信任来源。** `RequestTrust` 在显式列表之外增加一个可变的“回环地址可信”状态，由 Serve 状态刷新：启动时、连接设备页读取时，以及每 30 秒一次。放弃保存开关和默认信任回环地址，理由见 proposal。放弃仅在请求到来时检测：第一次登录就需要结果，异步判断会让登录路径变复杂。定时读取只运行一个短命令，Tailscale 未安装时立即结束；`--no-auth` 和监听具体网卡时不运行。

**状态来源。** 用 `tailscale status --json` 的 `BackendState` 和 `Self` 能力判断运行、登录和 HTTPS，用 `serve status --json` 判断根路径目标和 `AllowFunnel`。结果作为 `WebAccessState` 的 `tailscale` 字段返回给页面，状态是封闭枚举，并带占用目标、错误信息等必要字段。不新增 RPC，不调用任何写入配置的 Tailscale 命令。

**开启命令。** 页面显示 `tailscale serve --bg http://127.0.0.1:<端口>`，只在根路径未转发时显示。根路径已转发到别处时不显示，因为这条命令会直接替换现有转发。只监听具体网卡时本机访问条件无法满足，连接设备页读不到 Tailscale 状态，启动输出已说明这一点，因此不设对应状态。

**地址种类。** `WebNetworkAccessUrl.kind` 增加 `public` 和 `tailscale-funnel`。排序为 `public`、`tailscale-funnel`、`tailscale-https`、`tailscale`、`lan`、`virtual`。

**启动输出。** Serve 地址在第一行之后单独读取，超时 3 秒。第一行格式不变，就绪解析不受影响。

**电脑离线。** `watchAuthentication` 把探测结果分成三类：401 进入登录页；200 表示 Web 可达；网络错误、超时和其他状态码表示无法到达。探测增加 5 秒超时；连续两次无法到达时（约 10 秒）发布“电脑离线”，`HostConnectionStatus` 显示 `computer` 状态，探测成功或连接恢复后清除。Serve 和隧道在 Web 未运行时返回 502，电脑关机时请求超时，两者都归为电脑离线，不再细分，处理方式相同。

`auth-watch.ts` 和 `HostConnectionStatus` 之间用一个小的共享状态连接，不扩展 `dsh-client-connection` 的 `ConnectionState`：这个包来自上游，判断也只属于 Web 认证和远程访问。

**公开地址。** 启动时校验一次，结果加入连接设备页和启动输出。不增加界面配置，与 `--trusted-proxy` 保持一致。不把它加入同源白名单：隧道应保留 Host 或配置可信代理，两种做法都写入文档。

## Risks / Trade-offs

- [Serve 开启期间，frp TCP、`ssh -R` 等来自回环地址的请求也能伪造转发头] → 影响限于绕过按地址的限速（token 有 256 位熵）和让 Cookie 带 Secure。这些头不会让请求算作本机访问；跨站页面无法设置这些头，所以不能绕过同源校验。
- [检测有最多约 30 秒延迟] → 手动开启 Serve 后，这段时间内的登录 Cookie 不带 Secure，同一设备下次登录时修正。
- [Web 未运行时，占用同一端口的其他程序会被 Serve 转发到 tailnet] → Serve 由用户配置，Web 不修改；页面和文档说明这一点。
- [Tailscale 命令输出格式变化] → 只解析 JSON 状态，解析失败时报告读取失败，不影响其他连接方式。

## Migration

不改变持久化格式。升级后已手动开启的 Serve 自动获得可信代理，已有 Cookie 继续有效，下次登录时才带 Secure。回滚时 Serve 配置保留在 Tailscale 中，旧版本继续把它当作只读地址。
