# Web 远程访问

用手机或其他设备访问这台电脑上的 codexhost Web。

使用前提：电脑开机并保持联网，Web 正在运行。关闭 Web 后手机无法访问，但共享 Host 上的任务不会停止。

## 选择连接方式

| 方式 | 适合场景 | 需要准备 | 加密 | 谁能打开登录页 | 配置 |
| --- | --- | --- | --- | --- | --- |
| [同一 Wi-Fi](#同一-wi-fi) | 在家或办公室，临时连接 | 无 | 否（HTTP） | 同一网络的设备 | 页面点击启用 |
| [Tailscale HTTPS](#tailscale-https推荐) | 只有自己的设备，跨网络使用（推荐） | 手机和电脑都装 Tailscale | 是 | tailnet 策略允许的设备 | 页面点击启用 |
| [Tailscale IP](#tailscale-ip) | 已有 Tailscale，暂未开启 HTTPS | 手机和电脑都装 Tailscale | Tailscale 网络加密，Web 本身是 HTTP | tailnet 策略允许的设备 | 页面点击启用 |
| [Relay 中转](#relay-中转) | 跨网络使用，手机不装 App | 自备 Relay 和电脑端证书 | 是，TLS 在电脑上解开 | 互联网上的任何人 | `--relay` + 页面开关 |
| [Cloudflare Tunnel](#cloudflare-tunnel) | 有 Cloudflare 域名，手机不想装 App | 域名、`cloudflared` | 是 | 互联网上的任何人 | 命令行 |
| [Tailscale Funnel](#tailscale-funnel) | 手机不装 Tailscale，也没有域名 | 电脑装 Tailscale，策略允许 Funnel | 是 | 互联网上的任何人 | 命令行 |
| [nginx](#nginx) | 已有证书和反向代理 | nginx、域名、证书 | 是 | 取决于 DNS 和防火墙 | 配置文件 |
| [frp + nginx](#frp--nginx) | 有公网服务器，电脑没有公网入口 | 公网服务器、frp、nginx、证书 | 是 | 互联网上的任何人 | 配置文件 |

**不管用哪种方式，其他设备都必须有访问令牌才能进入。** 令牌持有者可以操作这台电脑，登录链接和二维码要按密码一样保管。不要向网络开放 `--no-auth`。

完整认证规则见[访问认证](standalone-web.md#访问认证)。

## 启动 Web

| 操作 | 安装包或 npm | 源码开发 |
| --- | --- | --- |
| 启动 | `codexhost web`（后台运行，终端可关闭） | `npm start web`（前台运行） |
| 默认监听 | `127.0.0.1:4400`（仅本机） | `0.0.0.0`（对外） |
| 查看状态 | `codexhost status` | — |
| 登录后自动启动 | `codexhost autostart on`，关闭用 `off` | — |
| 停止 | `codexhost stop` | 在独立终端运行 `npm stop` |

安装包的完整命令路径见[独立 Web 应用](standalone-web.md#安装版后台-web)。

- `codexhost stop` 会停止 codexhost 管理的 GUI、Web、Host、远程服务、Broker 和 Console，并中断任务；不删除会话，也不修改自启和 Serve 配置。
- `npm stop` 也会停止已识别的后台 Web。
- 后台 Web 占用端口时，`npm start web` 启动失败且不结束后台 Web，可改用 `npm start web -- --port 4401`。

## 在连接设备页连接

在这台电脑上打开“设置 → 连接设备”，选择连接方式后用手机相机扫码，或点“复制链接”发到手机。二维码和复制的链接都包含令牌，页面上不显示完整令牌。

选择方式、切换地址、打开页面和刷新状态都不会改变网络配置。IP / Tailscale HTTPS 通过“启用并显示二维码”开启；中转通过独立开关开启。

### 同一 Wi-Fi

手机和电脑连接同一网络，选择“同一 Wi-Fi”。后台 Web 首次使用时：

1. 点击“启用并显示二维码”。Web 会保存全网卡 HTTP 监听并重启，Web 终端会断开，Host 任务不受影响。
2. 等待二维码出现后扫码。之后再进入页面会直接显示。

也可以用命令开启，配置同样会保存：`codexhost web --host 0.0.0.0`。

> **HTTP 不加密。** 内容以明文传输，只在你信任的网络中使用。

前台 Web 不能在页面上更改监听地址，可以使用已有地址或 Tailscale HTTPS。

### Tailscale HTTPS（推荐）

只有 tailnet 内被允许的设备能访问。对应 Tailscale Serve。

**准备：**

1. 电脑和手机都安装并登录 Tailscale，tailnet 访问策略允许手机连接电脑。
2. 在 Tailscale 管理后台开启 HTTPS 证书。

**连接：** 选择“Tailscale → HTTPS”。页面会按当前状态提示下一步（未安装、未运行、未登录、未开启 HTTPS、未转发、根路径被占用或读取错误）。可以转发时，点击“启用并显示二维码”；已配置则直接显示二维码。

也可以自己运行命令，端口要和 Web 的 `--port` 一致：

```sh
tailscale serve --bg http://127.0.0.1:4400
```

macOS 只安装了 App 时，命令位于 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`。Web 会先查找 `tailscale`，找不到再尝试这个路径。

> **转发配置不会随 Web 退出。** `--bg` 配置在 Web 退出、`codexhost stop` 和更新后都保留，之后占用同一端口的其他程序也会被转发。不再需要时用下面的“停止设备访问”关闭，或在 Tailscale 中管理。

**常见问题：**

- **443 根路径已被占用：** 页面显示当前目标，不提供启用按钮，因为上面的命令会替换现有转发。请先在 Tailscale 中调整。
- **监听具体网卡：** 无法查看连接设备页，Serve 也无法转发。请监听回环或通配地址，后台 Web 可用 `codexhost web --host 127.0.0.1` 保存，源码用 `npm start web -- --host 127.0.0.1`。

### Tailscale IP

选中 Tailscale 且检测到 Tailscale IP 时，可以切换到“IP”。地址形如 `100.x.x.x:4400`，手机同样要开着 Tailscale。首次使用的启用步骤和同一 Wi-Fi 相同。

Web 本身走 HTTP，由 Tailscale 网络加密传输。能开启 HTTPS 时优先用 HTTPS。

### Relay 中转

电脑主动连接 Relay，手机通过 `https://<id>.<中转域名>/` 访问，不需要安装额外 App。Relay 转发加密字节，TLS 在电脑上的 Web 进程解开，不新开本地监听端口。

- 安装版用 `codexhost web --relay <控制主机名>` 保存控制地址；传 `--relay ""` 清除。配置变更按其他启动选项重启 Web。源码预览用 `npm start web -- --relay <控制主机名>`，同样保存中转地址。
- 没有内置官方地址。配置后，本机“连接设备”页才显示中转开关。开关默认关闭，状态保存为 `service.json` 的 `relayEnabled`；切换即时生效，不重启 Web 或 Host。`--no-auth` 时不会连接，也不能开启。
- 状态包括关闭、连接中、已连接、缺少证书和已停止。开关后页面刷新，也可手动“刷新状态”；只有已连接地址参与二维码选择。
- 首次开启生成 `<web-data>/remote-relay/identity.pem`（Ed25519 PKCS#8，权限 0600）。地址由公钥派生，重启、更新沿用同一文件。不要分享私钥；文件丢失或删除后重新开启会得到新地址，旧地址无法找回。
- 电脑端从同目录读取 `certificate.pem` 与 `certificate-key.pem`，开启时读取一次。**自动证书申请和续期尚未实现**；缺少可用证书时仍注册，但关闭手机连接。当前自动化验收使用测试 CA，不代表真实手机已可使用。
- 出站默认为 WSS 443。`HTTPS_PROXY`（或 `https_proxy`）为 `http://` 代理时使用 CONNECT，仍校验控制地址的 TLS 证书。暂不支持 `NO_PROXY`、SOCKS 和代理认证。
- 连接尝试（含 DNS、CONNECT、TLS、升级及注册）限时 30 秒；60 秒未收到 WebSocket ping 则断开重连。退避从 1 秒倍增到 60 秒，每次随机取上限的 50%–100%；注册稳定 60 秒后重置退避。被替换、签名被拒、版本不支持时停止，不自动争抢身份；处理原因后关闭再打开开关或重启 Web。
- 中转请求始终是非本机 HTTPS；忽略 `x-forwarded-*`，按 Relay 告知的手机 IP 限速。Origin 必须完整匹配该电脑的 HTTPS 来源。响应含 `Strict-Transport-Security: max-age=31536000`，不包含子域；只协商 HTTP/1.1，不宣告 HTTP/3 或 ECH。

## 使用自己的域名或隧道

以下方式都需要在命令行配置，配好后页面不提供编辑入口。下面的例子用 `code.example.com`，请替换成你的域名。

三个参数的作用：

| 参数 | 作用 | 注意 |
| --- | --- | --- |
| `--host 127.0.0.1` | Web 只监听本机，由代理转发 | Web 的 HTTP 端口不要对公网开放 |
| `--public-url https://code.example.com` | 让链接和二维码使用这个地址 | 只影响地址显示，不会自动信任代理 |
| `--trusted-proxy 127.0.0.1` | 指定**直接连接 Web 的代理 IP** | 不要填浏览器、域名或上游 CDN 的地址 |

`codexhost web` 会把这些参数保存到 Web 数据目录的 `service.json`，后续启动沿用。配置后，页面在“其他连接方式”中显示“公开地址”，并优先选中它。

### Cloudflare Tunnel

浏览器到 Cloudflare 是 HTTPS，电脑不需要开放入站端口。

**1. 创建 Tunnel 并绑定域名**（域名需托管在 Cloudflare）：

```sh
cloudflared tunnel login
cloudflared tunnel create codexhost
cloudflared tunnel route dns codexhost code.example.com
```

**2. 写入 `cloudflared` 配置：**

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

**3. 启动 Tunnel 和 Web：**

```sh
cloudflared tunnel --config /path/to/config.yml run codexhost

codexhost web --host 127.0.0.1 --port 4400 \
  --public-url https://code.example.com --trusted-proxy 127.0.0.1
```

**注意：**

- 要允许 WebSocket，不要为应用流量开启会缓冲事件流的代理规则。
- 这个例子明确保留外部 Host；可信代理设置用于接受 HTTPS 协议和客户端地址头。
- 互联网上的任何人都能打开登录页。Cloudflare Access 可以额外限制访问，但不能代替 Web 令牌。
- 这不是端到端加密，见[谁能看到内容](#谁能看到内容)。

### Tailscale Funnel

手机不用加入 tailnet，但互联网上的任何人都能打开登录页。需要 Tailscale 账号，且 tailnet 策略允许 Funnel。

先确认 HTTPS 根路径没有其他用途，再运行：

```sh
tailscale funnel --bg http://127.0.0.1:4400
```

Web 不会替你开启 Funnel，只读取 `AllowFunnel`，把对应地址标为“Funnel · 公开”。和 Serve 一样，配置在 Web 退出后仍保留。

### nginx

以下片段放在 nginx 的 `http` 上下文，假设 Web 和 nginx 在同一台电脑。替换域名和证书路径：

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

启动 Web：

```sh
codexhost web --host 127.0.0.1 --port 4400 \
  --public-url https://code.example.com --trusted-proxy 127.0.0.1
```

源码 packed 目录可将 `codexhost web` 换成 `node preview.mjs`，参数只对该次前台运行生效。

入口能被谁访问取决于 DNS、防火墙和监听网络；公网 nginx 的登录页任何人都能打开。如果 nginx 在其他机器上，`--trusted-proxy` 要改成它的直连 IP，并单独保护 nginx 到 Web 的传输。

### frp + nginx

把公网服务器的 TCP 入口转到电脑上的 nginx，HTTPS 一直到电脑才解开，公网服务器看不到内容。DNS 把 `code.example.com` 指向公网服务器。

**1. 公网服务器 `frps.toml`：**

```toml
bindPort = 7000
auth.method = "token"
auth.token = "replace-with-a-private-frp-token"
```

**2. 电脑 `frpc.toml`：**

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

**3. 电脑上的 nginx：** 使用上一节的配置，把 `listen 443 ssl;` 改成 `listen 127.0.0.1:8443 ssl;`，证书仍用 `code.example.com`。

**4. 启动 Web：** 参数和 nginx 相同。

**注意：**

- 互联网上的任何人都能打开登录页。
- frp token 和 Web 访问令牌是两份不同的凭据。
- nginx 只能看到 frpc 的回环来源，无法按手机的真实 IP 分别限速。不要伪造或凭空信任客户端地址。
- 不要把 TCP 通道直接接到 Web 的明文 HTTP 端口。如果改为在公网 nginx 解开 TLS，那台 nginx 就能看到内容，后续传输也要单独保护。

### 自备代理的要求

使用其他代理时，也要满足以下要求：

- **转发 WebSocket Upgrade**，禁用事件流缓冲，允许长连接。不能只转发普通页面请求。
- **挂在站点根路径**，不支持子路径。
- **保留原始 `Host`。** 如需改写，必须配置可信代理并写入外部 `X-Forwarded-Host`。
- **覆盖转发头。** 终止 HTTPS 的代理应覆盖 `X-Forwarded-Proto: https` 和客户端 `X-Forwarded-For`，不要透传浏览器伪造的值。

Web 只取可信直连代理写入的最右侧值，用于同源校验、Secure Cookie 和按客户端地址限速。

## 谁能看到内容

| 方式 | TLS 在哪里解开 | 能接触内容的一方 |
| --- | --- | --- |
| 同一 Wi-Fi | 不使用 TLS | 电脑；同一网络中的其他设备也可能截获 |
| Tailscale IP | 不使用 TLS，由 Tailscale 网络加密 | 电脑 |
| Tailscale HTTPS | 电脑上的 Tailscale Serve，再经回环 HTTP 到 Web | 电脑 |
| Tailscale Funnel | 电脑上的 Tailscale；公网中继只转发加密流量 | 电脑 |
| Cloudflare Tunnel | Cloudflare 边缘；之后经加密 Tunnel 到 `cloudflared`，再经回环 HTTP 到 Web | **Cloudflare** 和电脑 |
| nginx | nginx | nginx 管理者和电脑 |
| frp + nginx | 电脑上的 nginx；frps 和 frpc 只转发密文 | 电脑 |

Serve 生效期间，其他回环代理也会被信任，不要把它当成隧道身份认证。

## 管理访问

这些操作在连接设备页的地址下方，只能在这台电脑上使用。手机只显示引导和退出登录。

| 操作 | 说明 |
| --- | --- |
| 复制令牌 | 用于在其他设备的登录页手动输入 |
| 重新生成 | 旧令牌立即失效，需要确认 |
| 登录后自动启动 | 仅后台模式显示，失败原因显示在开关旁 |
| 停止设备访问 | 有可停止的入口时显示，需要确认 |

“连接遇到问题？”里有网络提示、Tailscale 下载，以及自备隧道或代理（frp、Cloudflare Tunnel、nginx）的说明和本文链接。

### 停止设备访问

确认后：

1. 逐个移除指向当前 Web 的 Tailscale HTTPS 根路径，保留其他服务的根路径和其他路径。
2. 关闭后台 Web 的全网卡监听，重启为仅本机监听。

运行中的任务不受影响。任何一步失败，都会重新读取实际状态并显示错误。多个 HTTPS 根路径最多连续处理 16 个，还有剩余时提示重试。

**不受影响的入口：** 自备的外部代理和前台监听不由这个操作管理，确认弹窗会说明，页面也仍显示它们。比如 `npm start web` 下停止后，Wi-Fi 地址依然可用。

### 卸载前清理

1. **停止服务：** Windows 卸载程序会停止服务、关闭自启并提醒 Serve 配置保留，覆盖安装不关闭自启。macOS 删除应用或 npm 用户执行 `npm uninstall -g @codexhost/cli` 前，先运行 `codexhost stop` 和 `codexhost autostart off`。回退到不支持后台 Web 的旧版前也要这样做。
2. **移除 Serve：** 它不会随卸载撤销。Web 运行时可以用“停止设备访问”；否则先确认根路径仍指向此 Web，再移除：

   ```sh
   tailscale serve status
   tailscale serve --https=443 --set-path=/ off
   ```

   非 443 的 HTTPS 转发换成实际端口。不要移除属于其他服务的根路径，也不要省略 `--set-path=/`，否则会删除该端口的其他路径。

## 手机上的连接提示

| 提示 | 含义 | 处理 |
| --- | --- | --- |
| 网络断开 | 手机浏览器没有网络 | 检查手机网络 |
| 连接中 / 正在重连 | 正在首次连接或恢复长连接 | 等待 |
| 回到登录页并提示登录失效 | 令牌已失效，比如被重新生成 | 重新扫码或输入新令牌 |
| 确认电脑开机且 Web 正在运行 | 连续约 10 秒无法连接 | 检查电脑后重试 |
| Host 不可用 | Web 可达，但 Host 未就绪 | 等待恢复或检查 Host |

中断不会清空已有内容或未发送的草稿，也不会重发结果不明的操作。恢复后提示自动消失。

## 技术参考

### 地址规则

- **`--public-url`：** 只接受 `http`、`https` 的根地址（可带端口和结尾 `/`），不允许用户信息、路径、查询或片段，无效值使启动失败。HTTP 可用，但以明文传输。它只用于链接和二维码，不会成为可信代理、同源白名单或本机访问。
- **参数来源：** 后台 Web 读取保存的设置，不沿用 Web 环境变量。源码入口 `npm start web -- --public-url ...`、`node preview.mjs --public-url ...` 和直接入口 `node app/server.mjs --public-url ...` 支持参数或 `CODEXHOST_WEB_PUBLIC_URL`，命令行优先；preview 在清理环境前把环境变量转成参数。`--trusted-proxy` 接受逗号分隔的多个 IP；直接入口也接受 `CODEXHOST_WEB_TRUSTED_PROXIES`，preview 使用命令行参数。
- **页面默认选择：** 公开地址、已连接的中转地址、Funnel、Serve HTTPS、Tailscale IP、局域网、虚拟网卡。没有可用入口时优先预览局域网候选地址，否则显示 HTTPS 设置。同一方式有多个地址时提供下拉选择。
- **终端地址顺序：** 公开地址、启动输出时已连接的中转地址、Funnel、Serve HTTPS、Tailscale IP、局域网；只有没有其他地址时才显示虚拟网卡。
- **候选地址：** 后台 Web 首次只监听本机，`directCandidates` 提供网卡候选地址供预览，与已配置入口 `networkUrls` 分开。

### 启动输出

`codexhost web` 输出本机登录链接和后台运行提示。前台 preview 输出 `codexhost web: http://.../?token=...` 后检测 Tailscale，最多等待 3 秒，失败不阻止启动或其他地址使用。前台终端二维码不含访问令牌，登录二维码在本机连接设备页查看。

### Tailscale 检测与信任

- **检测命令：** 只调用 `tailscale status --json` 和 `tailscale serve status --json`。`--no-auth` 或监听具体网卡时不运行。
- **开启：** 点击启用时重新读取状态，根路径已被占用则不写入。开启成功后页面默认选中 Tailscale HTTPS。
- **关闭：** 明确使用 `--https=<检测到的端口> --set-path=/ off`，只移除指向当前 Web 的根路径；根路径指向别处时不提供关闭操作。
- **结果确认：** 每次操作后重新读取状态，命令退出 0 但配置未生效也显示失败。
- **信任：** 检测到 HTTPS 根路径指向当前 Web 后，自动信任回环代理头，登录 Cookie 带 Secure，失败按手机的 tailnet IP 分别限速。启动和本机读取连接设备页时更新，并每 30 秒读取一次 Serve 状态；撤销转发后约 30 秒恢复不信任。
- **本机判断：** 经 Serve 的请求不算本机访问。经代理或其他设备的请求不能开关 Serve，判断方式与查看令牌相同。
- **端口：** 非 443 HTTPS 端口也会识别，例如 `https://host:8443/`；443 地址省略端口。

### 浏览器隔离

所有入口的页面带 `Content-Security-Policy: frame-ancestors 'self'`，拒绝跨来源嵌入。HTTPS 登录使用 `__Host-codexhost_token`，属性为 Secure、HttpOnly、SameSite=Lax、Path=/，不设置 Domain；HTTP 使用 `codexhost_token`。读取时只认对应协议的名字，不兼容旧 HTTPS Cookie，升级后 HTTPS 入口需重新登录一次。

### 重连探测

重连期间探测 `/api/auth/status`，每次最多 5 秒。401 回登录页；200 清除“电脑离线”；连续两个失败的探测窗口（约 10 秒，包括网络错误、超时和 502 等非 200/401 状态）后提示电脑离线并提供重试。

## 验证状态

| 方式 | 是否实际运行验证 |
| --- | --- |
| 同一 Wi-Fi、Tailscale IP | 只有 Playwright 覆盖页面流程，未单独记录真实设备连接。 |
| Tailscale Serve / Funnel | 用户实测 Tailscale 访问正常，未分平台记录。真实 Tailscale 1.104.1 只读检测覆盖已转发、被占用、只装 App、未安装。未运行、未登录、未开启 HTTPS 和 Funnel 只由假 CLI 自动化覆盖。真实转发头未单独核对，切网、锁屏和电脑离线后恢复未单独记录。 |
| Relay 中转 | 本机真实 Relay + 测试 CA 覆盖注册、重连、代理、TLS 登录 / RPC / WebSocket、限速隔离及大下载并发；Playwright 覆盖开关、状态、地址顺序和手机布局。未验证公网 443、真实 CA 或 iOS/Android。 |
| nginx | **未实际运行：** 本地未安装 nginx。示例的证书、TLS、WebSocket 和事件流需由部署者验证。 |
| frp | **未实际运行：** 本地未安装 frpc/frps。公网端口、证书和完整链路需由部署者验证。 |
| Cloudflare Tunnel | **未实际运行：** 没有配置 Tunnel、域名或凭据，创建和启动命令也未执行。 |

自动化覆盖范围：

- **假 Tailscale CLI（HTTP 和 Playwright）：** 开启、确认时根路径已占用、退出 0 未生效、仅移除根路径、拒绝非本机请求。未修改真实 Tailscale 配置。
- **假 Launcher：** 自启状态、开关及 stderr 失败提示。
- **Playwright：** 候选地址预览不启用监听、首次启用后恢复二维码、后续打开保持可用、多个 HTTPS 根路径的停止范围、令牌操作与重新生成、手机只显示引导、手机宽度布局，以及连续失败、短暂中断、探测超时、502、恢复后草稿与消息保留。

以上不等于 iOS/Android 真机验收。
