# Proposal

## Why

Web 主动连接 `add-remote-relay-server` 提供的 Relay，在进程内解开手机的 TLS，交给现有 HTTP 服务。证书申请和续期由 `add-web-remote-certificates` 提供。

## What Changes

- Web 新增中转连接：首次开启时生成身份密钥并保存在数据目录，按 Relay 协议通过出站 WSS 注册，得到固定地址 `https://<id>.<域名>`。
- 每条经 Relay 到达的手机连接在 Web 进程内完成 TLS，再交给现有 HTTP 服务。不新开监听端口，现有页面、RPC、WebSocket 不变。
- 经中转的请求一律按非本机、HTTPS 处理，登录失败限速按 Relay 告知的手机 IP 计数。
- 断线后带随机抖动的退避重连，不重启 Host 或 Web，地址和 token 不变。被同一身份替换、协议版本不被支持时停止重连并提示原因。
- 中转地址通过 `codexhost web --relay <控制地址>`（或 `npm start web -- --relay`）配置并保存。配置后，连接设备页显示中转开关、地址、连接状态和身份密钥说明；开关即时生效，不重启 Web。
- HTTPS 访问时，登录 Cookie 改用 `__Host-` 前缀，防止同一中转域名下的其他子域覆盖它。所有入口的页面禁止被其他来源嵌入；经中转的响应带 HSTS，同源校验比较完整 Origin。
- `--no-auth` 时不能开启中转。

## Decisions

- **连接放在 Web 进程，不放在 Rust 或 Host。** TLS 必须在把字节交给 HTTP 服务的进程里解开，放在别处就要再转一次明文。Web 重启时中转随之重连，Relay 会用新连接替换旧连接。
- **显式配置控制地址。** 只有配置了 `--relay` 才显示中转开关，自托管也用同一个选项。
- **证书由第三个 change 提供。** 本 change 从数据目录读取证书；没有证书时仍注册（证书申请需要先注册），但把手机连接直接关闭，状态显示缺少证书。所以单独完成本 change 还不能用真手机访问，自动化测试使用测试 CA。
- **只提供 HTTP/1.1。** 进程内 TLS 只协商 `http/1.1`，现有 HTTP 服务不用改。Web 不发送 Alt-Svc，也不发布 ECH 配置，因为 Relay 只能路由 TCP 上的明文 SNI。
- **被替换后不自动重连。** 同一身份密钥被拷到两台电脑时，两边会无限互相替换，所以收到“被替换”后停止，由用户处理。
- **代理只认 `HTTPS_PROXY`。** 原生监管进程已把系统代理写入 Web 的环境变量。不处理 `NO_PROXY`，也不使用 Node 的环境代理支持，因为 Node 22.19 还没有。

## Capabilities

### New Capabilities

- `web-relay-access`：电脑端的中转设置、身份密钥、连接与重连、进程内 TLS，以及经中转请求的归属。

### Modified Capabilities

- `web-access-tokens`：HTTPS 访问的登录 Cookie 使用 `__Host-` 前缀；连接设备页把已连接的中转地址列为首选之一。

## Impact

- `packages/web-server`：新增中转客户端模块（建议目录 `src/remote-relay/`），`main.ts` 只做装配；`request-trust.ts` 识别经中转的连接；`auth.ts` 的 Cookie 名；`background-service.ts` 保存 `--relay`；新增中转相关 RPC。依赖 `@codexhost/remote-relay` 的协议导出。
- `packages/shared-contracts`：中转状态类型。
- `apps/web-ui`（`ui-codexhost`）：连接设备页的中转开关、地址和状态。
- 已通过 HTTPS 登录的浏览器（Tailscale Serve、公开地址）在升级后需要重新登录一次，因为 Cookie 改了名字。
