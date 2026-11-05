# Web 远程访问

Web 支持 Tailscale Serve、Funnel 和用户自备的 HTTPS 代理或隧道。Web 不安装、登录或修改 Tailscale；连接设备页只读状态并提供可复制的命令。电脑必须开机、保持网络连接且 Web 正在运行。关闭 Web 不会停止共享 Host 上的任务，但手机无法再访问 Web。

## 地址、认证与代理

- `--public-url https://code.example.com` 或 `CODEXHOST_WEB_PUBLIC_URL` 指定其他设备访问的站点根地址，命令行优先。`npm start web -- --public-url ...`、`node preview.mjs --public-url ...` 和直接入口 `node app/server.mjs --public-url ...` 都支持；preview 在清理环境前将环境变量转成参数。
- 只接受 `http`、`https` 的根地址（可带端口和结尾 `/`），不允许用户信息、路径、查询或片段。无效值使启动失败。HTTP 可用，但以明文传输内容，页面会提示风险。
- 地址选择顺序：配置的公开地址、Funnel、Serve HTTPS、Tailscale IP、局域网、虚拟网卡。虚拟地址在页面中折叠，终端只在没有其他地址时显示它们。
- 启动第一行仍是 `codexhost web: http://.../?token=...` 本机链接。Tailscale 检测在第一行之后进行，最多等待 3 秒，失败不阻止启动或其他地址使用。终端二维码不含访问令牌；登录二维码在本机设置的“连接设备”页查看。
- 公开地址只用于链接和二维码，不自动成为可信代理、同源白名单或本机访问。其他设备始终需要访问令牌，不能查看或重新生成令牌。不要向网络开放 `--no-auth`。
- 自备代理用 `--trusted-proxy <ip>[,<ip>...]` 指定**直接连接 Web 的代理 IP**；直接入口也接受 `CODEXHOST_WEB_TRUSTED_PROXIES`，preview 使用命令行参数。不要填浏览器、域名或上游 CDN 的地址。
- 代理应保留原始 `Host`；如需改写 Host，则必须配置可信代理并写入外部 `X-Forwarded-Host`。HTTPS 终止代理应覆盖 `X-Forwarded-Proto: https` 和客户端 `X-Forwarded-For`，不要透传浏览器伪造的值。Web 只取可信直连代理写入的最右侧值，用于同源校验、Secure Cookie 和按客户端地址限速。
- 代理必须转发 WebSocket Upgrade，禁用事件流缓冲，并允许长连接；不能只转发普通页面请求。不要把 Web 挂在子路径下。

完整认证规则见[访问认证](standalone-web.md#访问认证)。令牌持有者可以操作电脑，登录链接和二维码应按凭据保管。

## Tailscale Serve：仅 tailnet 可访问

电脑安装并登录 Tailscale。Web 先查找 `tailscale`，找不到时再尝试 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`。macOS 只安装 App 时，页面命令中的 `tailscale` 需要用户自行启用 CLI，或替换为该 App 内路径。手机也需安装、登录 Tailscale，并由 tailnet 访问策略允许连接电脑。在管理后台开启 HTTPS 证书。

Web 可监听回环地址，例如在源码开发入口使用 `npm start web -- --host 127.0.0.1`。本机打开“设置 → 连接设备”，页面在未安装、未运行、未登录、未开启 HTTPS、未转发、根路径占用或读取错误时显示 Tailscale 提示；正常转发时只在连接方式中提供地址，不显示独立状态区。HTTPS 443 根路径未占用时显示以下命令，**由用户在终端自行执行**：

```sh
tailscale serve --bg http://127.0.0.1:4400
```

端口应与 Web 的 `--port` 一致。没有 HTTPS 根路径转发到当前 Web、但 443 根路径已指向其他目标时，页面显示目标而不提供开启命令，因为该命令会替换现有转发。监听具体网卡时无法查看连接设备页，Serve 也无法转发，应监听回环或通配地址。

Web 只调用 `tailscale status --json`、`tailscale serve status --json`。检测到 HTTPS 根路径指向当前 Web 后，自动信任回环代理头，登录 Cookie 带 Secure，失败按手机的 tailnet IP 分别限速。启动和本机读取连接设备页时更新，每 30 秒读取一次 Serve 状态；撤销转发后约 30 秒恢复不信任。`--no-auth` 或监听具体网卡时不运行检测。经 Serve 的请求不算本机访问。非 443 HTTPS 端口也会识别，例如 `https://host:8443/`；443 地址省略端口。

TLS 在电脑上的 Tailscale Serve 解开，再经回环 HTTP 送到 Web；tailnet 允许的设备能接触入口，电脑能看到内容。Serve 生效期间，其他回环代理也会被信任；不要把这当成隧道身份认证。

**`--bg` 配置在 Web 退出后仍保留。占用同一端口的其他程序也会被转发。** Web 不自动移除配置；由用户在 Tailscale 中管理。

## Tailscale Funnel：互联网公开入口

需要 Tailscale 账号及 tailnet 策略允许 Funnel。由用户检查 HTTPS 根路径的现有用途后自行配置，例如：

```sh
tailscale funnel --bg http://127.0.0.1:4400
```

这不是 Web 提供的执行操作。Web 只读取 `AllowFunnel`，将对应地址标为“Funnel · 公开”。**任何人都能访问登录页，仍需访问令牌才能进入。** 手机无需加入 tailnet。公网 Funnel 中继转发加密流量，TLS 在电脑上的 Tailscale 解开；电脑可看到内容。Funnel 同样有退出后配置仍保留的风险。

## nginx：自备 HTTPS 反向代理

以下片段放在 nginx 的 `http` 上下文；替换域名与证书路径。Web 与 nginx 位于同一台电脑，Web 监听 `127.0.0.1:4400`：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
server {
    listen 443 ssl;
    server_name code.example.com;
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4400;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

Web 参数示例（已构建的发行目录）：

```sh
node preview.mjs --host 127.0.0.1 --port 4400 \
  --public-url https://code.example.com --trusted-proxy 127.0.0.1
```

这个配置保留 Host，同时显式写入可信转发头。TLS 在 nginx 解开，nginx 管理者及 Web 电脑可看到内容。入口能被谁访问取决于 DNS、防火墙和监听网络；公网 nginx 的登录页可被任何人访问。Web 的 HTTP 端口不应对公网开放。若 nginx 位于其他机器，可信代理应改为其直连 IP，并单独保护 nginx 到 Web 的传输。

## frp：将公网 TCP 入口转给电脑上的 nginx

此示例让浏览器 HTTPS 一直转发到电脑上的 nginx，不在公网 frps 解开 TLS。DNS `code.example.com` 指向公网服务器。

公网服务器 `frps.toml`：

```toml
bindPort = 7000
auth.method = "token"
auth.token = "replace-with-a-private-frp-token"
```

电脑 `frpc.toml`：

```toml
serverAddr = "relay.example.com"
serverPort = 7000
auth.method = "token"
auth.token = "replace-with-a-private-frp-token"
transport.tls.enable = true

[[proxies]]
name = "codexhost-web"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8443
remotePort = 443
```

电脑上的 nginx 使用上一节的配置，但将 `listen 443 ssl;` 改为 `listen 127.0.0.1:8443 ssl;`；证书仍为 `code.example.com`。Web 参数同上一节：`--public-url https://code.example.com --trusted-proxy 127.0.0.1`。

frp 的 TCP 通道原样转发 WebSocket 和事件流，流式/Upgrade 设置由 nginx 负责。公网任何人可到达登录页；frps 和 frpc 转发的是浏览器 TLS 密文，TLS 在本机 nginx 解开。这个拓扑的 nginx 只看到 frpc 的回环来源，无法按真实手机 IP 分别限速；不要伪造或凭空信任客户端地址。frp token 与 Web 访问令牌是两份不同凭据。

不要将 TCP 通道直接暴露到明文 Web HTTP 端口；如果改为公网 nginx 终止 TLS，则该 nginx 能看到内容，且应保护后续传输。

## Cloudflare Tunnel

已创建的命名 Tunnel 可用如下 `cloudflared` 配置，域名路由应指向该 Tunnel：

```yaml
tunnel: YOUR-TUNNEL-ID
credentials-file: /path/to/YOUR-TUNNEL-ID.json
ingress:
  - hostname: code.example.com
    service: http://127.0.0.1:4400
    originRequest:
      httpHostHeader: code.example.com
  - service: http_status:404
```

Web 使用 `--host 127.0.0.1 --public-url https://code.example.com --trusted-proxy 127.0.0.1`。此例明确保留外部 Host；可信代理设置还用于接受 HTTPS 协议和客户端地址头。不要为应用流量开启会缓冲事件流的代理规则，允许 WebSocket。

浏览器 TLS 在 Cloudflare 边缘解开；Cloudflare 与 cloudflared 之间通过加密 Tunnel 传输，cloudflared 再用回环 HTTP 连接 Web。因此 **Cloudflare 和电脑都能接触内容**，这不是浏览器到电脑的端到端 TLS。默认公网入口允许任何人到达登录页；额外的 Cloudflare Access 策略不替代 Web token。

## 手机连接提示

浏览器无网络时显示“网络断开”；初始连接和长连接恢复显示“连接中/正在重连”。重连期间探测 `/api/auth/status`，每次最多 5 秒：401 回登录页并提示登录失效；200 清除“电脑离线”；连续两个失败的 5 秒探测窗口（约 10 秒），包括网络错误、超时和 502 等非 200/401 状态，提示确认电脑开机且 Web 正在运行，并提供重试。

Web 可达但 Host 未就绪时提示 Host 不可用，而不是电脑离线。恢复后提示消失；网络/电脑/Host 中断不清空已有内容或未发送草稿，也不重发结果不明的操作。

## 验证状态

| 方式 | 实际运行验证 |
| --- | --- |
| Tailscale Serve / Funnel | 自动化用 PATH 最前的假 CLI 验证状态、Secure Cookie、限速和信任撤销；未运行真实 Tailscale，手机蜂窝网、切网和锁屏验收待用户执行。 |
| nginx | 未实际运行：本地未安装 nginx；示例的证书、TLS、WebSocket 和事件流需由部署者验证。 |
| frp | 未实际运行：本地未安装 frpc/frps；公网端口、证书和完整链路需由部署者验证。 |
| Cloudflare Tunnel | 未实际运行：没有为本次验证配置 Tunnel、域名或凭据。 |

Playwright 验证了手机宽度布局、连续失败/短暂中断、探测超时、502、恢复后草稿与消息保留；不等于 iOS/Android 真机验收。
