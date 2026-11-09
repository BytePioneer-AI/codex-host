# Web 远程访问

用手机或其他设备访问这台电脑上的 codexhost Web。

使用前提：电脑开机并保持联网，Web 正在运行。关闭 Web 后手机无法访问，但共享 Host 上的任务不会停止。

## 选择连接方式

| 方式 | 适合场景 | 需要准备 | 加密 | 谁能打开登录页 | 配置 |
| --- | --- | --- | --- | --- | --- |
| [同一 Wi-Fi](#同一-wi-fi) | 在家或办公室，临时连接 | 无 | 否（HTTP） | 同一网络的设备 | 页面点击启用 |
| [Tailscale HTTPS](#tailscale-https推荐) | 只有自己的设备，跨网络使用（推荐） | 手机和电脑都装 Tailscale | 是 | tailnet 策略允许的设备 | 页面点击启用 |
| [Tailscale IP](#tailscale-ip) | 已有 Tailscale，暂未开启 HTTPS | 手机和电脑都装 Tailscale | Tailscale 网络加密，Web 本身是 HTTP | tailnet 策略允许的设备 | 页面点击启用 |
| [Relay 中转](#relay-中转) | 跨网络使用，手机不装 App | 官方中转，或自备 Relay、域名和公网 443；电脑自动申请证书 | 是，TLS 在电脑上解开 | 互联网上的任何人 | 连接设备页选择官方或自建中转并启用 |
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

在这台电脑上点击 Web 侧栏“导入会话”下方的“远程访问”，或打开“设置 → 连接设备”，选择连接方式后用手机相机扫码，或点“复制链接”发到手机。两个入口打开同一个连接设备页，侧栏入口不切换当前主栏会话。二维码和复制的链接都包含令牌，页面上不显示完整令牌。

侧栏“远程访问”仅在服务端 `/api/auth/status` 确认本机访问（`local: true`）时显示，不按视口宽度或设备类型区分；远程访问、判定未完成或读取失败时隐藏。本机窄屏仍可使用此入口。远程用户仍可在设置中打开“连接设备”，查看本机操作引导并退出登录。

选择方式、选择已有访问地址、打开页面和刷新状态都不会改变网络配置。IP / Tailscale HTTPS 通过“启用并显示二维码”开启；“官方加密中转”在选中后点击“启用中转”开启，并可在同一处单独关闭。

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

已认证访问统计与原始网络连接分开：Web 在访问令牌/登录 Cookie 校验通过或已认证 WebSocket 升级时，才通过签名控制连接向 Relay 确认对应的转发连接；同一连接每个 UTC 日最多确认一次，跨日须再次出现已认证请求。Relay 使用自身观测的来源 IP，不信任浏览器的转发头；报告不包含令牌、Cookie、请求路径或内容。未认证的扫描和 ACME 验证不计入已认证访问，旧版本及历史连接不作认证推断。没有报告能力的旧 Relay 仍能连接，报告失败也不阻断登录；总流量继续包含所有转发字节。已认证连接数不等于用户数或登录操作次数。

电脑主动连接 Relay，手机通过 `https://<地址名>.<中转域名>/` 访问，不需要安装额外 App。Relay 转发加密字节，TLS 在电脑上的 Web 进程解开，不新开本地监听端口。公网 443 上的 Let's Encrypt 证书签发已验证可用。用自己的域名和服务器部署中转，见[自建中转](self-hosted-relay.md)。示例从源码通过 `docker compose up -d --build` 部署，只需一条 `*.example.com` 通配 DNS 指向服务器和公网可直达的 TCP 443，无需开放 80 或额外证书工具。控制地址默认 `relay.example.com`，由中转自动申请及续期 Let's Encrypt 证书；账户密钥、证书私钥和证书保存在容器 `/data` 的持久卷中，重启复用。Let's Encrypt 有频率限制，不要反复删除卷；已有证书时可选成对提供 `--cert/--key`。电脑地址可自选为 `<name>.example.com`，留空时使用 `<id>.example.com`。已有记录（如 `www`、根域）照常使用，通配只覆盖没有单独记录的子域；默认电脑地址使用 26 位公钥派生 ID；自选名称时需避开已有的独立 DNS 记录。Cloudflare 必须选“仅 DNS”；只在 IPv6 同样可达时添加 AAAA 记录。

- 本机“连接设备”页按“官方加密中转”“自建加密中转”、Tailscale、“同一 Wi-Fi”的顺序展示常用方式，“官方加密中转”和 Tailscale 均带“推荐”标识。官方固定使用 `relay.chost.dev`；自建卡片在关闭时依次用“中转域名”和“设备名称”两个带说明的输入框填写（如 `example.com` 和 `mycomputer`），下方预览框实时显示“启用后，手机将通过 `https://mycomputer.example.com` 访问这台电脑”，并标出各段来自哪个输入框；中转服务器地址随域名显示为 `relay.example.com`。点击“启用中转”同时保存并连接，前后端均校验，无单独保存按钮；已有非默认控制地址在未编辑基础域名时保持不变。开启后只读显示控制地址，访问地址和复制链接紧跟状态与开关。自建详情含从准备域名和服务器、获取源码开始的简短双语教程和[完整部署说明](self-hosted-relay.md)：默认收起为可展开的一行，点击后显示教程；没有域名时建议官方中转或 Tailscale。
- 中转默认关闭，选择卡片只预览；点击“启用中转”才注册和申请证书，启用状态保存在 `service.json` 的 `relayEnabled`，当前类型为 `relayKind`。同一时间只启用一个中转，当前卡片显示“当前使用”；切换类型或控制地址前必须先关闭，不会自动断开另一中转。页面保存与启停即时生效，不重启 Web 或 Host；“停止设备访问”也会关闭中转。`--no-auth` 时不会连接，也不能开启。
- 官方还未取得地址时，启用按钮前显示地址名（可选）和邀请码。地址名接受 4–20 位小写字母和数字；留空由中转分配。点击启用时，两项保存为 `relayRegistrations[控制地址].name`、`relayRegistrations[控制地址].invite`，每次官方注册时提交；空项不发送对应头。官方按先到先得分配名字，同一身份沿用原名，不支持改名。自建卡片不显示邀请码，注册时只提交地址名，不发送官方邀请码。自建 CLI 在 `/data/names.json` 持久保存名称与电脑身份的绑定，名称被占用时拒绝；名称留空使用公钥派生 ID。
- 注册信息、证书文件和签发记录按控制地址分别保存；更换当前中转类型或有效控制地址不删除，切回来直接复用，只清除内存额度提示。不同控制地址不共用地址和证书，即使新服务分配相同的域名。身份密钥、ACME 账户和证书私钥不变。只关闭后重开同一中转不清除分配地址与证书。
- 开发兼容入口 `codexhost web --relay <控制地址>` 仅预填或覆盖自建地址 `relayHost`，保留 `localhost:端口`；`--relay ""` 清除自建地址。它不改变官方卡片的固定地址，也不覆盖显式保存的 `relayKind`。旧配置没有 `relayKind` 时，`relayHost` 为 `relay.chost.dev`（或未配置）按官方类型读取，其他地址按自建类型读取；识别旧官方配置不会清除分配地址、证书或注册字段，无需手动重新注册。CLI 变更仍按启动选项重启 Web；中转开启时拒绝改址，须先在页面关闭。普通用户无需命令行。
- 注册成功后保存 `relayRegistrations[控制地址].hostname`；官方已有地址时，选中官方卡片即不再显示地址名和邀请码输入框，不受当前中转类型影响。关闭后重新启用、切回该中转、Web 重启和更新都沿用已取得地址。名字和邀请码不会因普通开关操作丢失。`service.json` 含邀请码，请勿分享。
- 状态按手机能否访问显示：关闭、准备中（连接、注册和首次申请证书，通常一分钟内完成，页面自动刷新）、已开启（附地址）、暂时无法使用（附自动重试时间）、需要处理（证书申请暂停，附证书机构的说明）和已停止。证书有效期与后台续期不显示。也可手动“刷新状态”；只有已开启的地址参与二维码选择。
- 注册被拒时按原因处理：`4410` 自动关闭中转，显示“邀请码无效或已被使用”；`4411` 自动关闭，显示“这个名字已被占用，请换一个”；`4412` 自动关闭，显示“此电脑已被停止使用该中转”。关闭开关保存到 `service.json`，不自动重连；收到 `4410` 或 `4411` 还会清除当前控制地址的 `relayRegistrations[控制地址].hostname`，重新显示输入框，以便身份密钥丢失或更换电脑后填写新邀请码。原因只保留在当前 Web 进程内，直到下次启用。拒绝原因显示在输入框上方，用户修改后可重新启用。`4413` 不关闭开关，显示“中转已满，正在自动重试”，沿用断线退避。
- 中转通过 `POST /v1/notice` 告知当天额度用完时，页面显示“今日流量已用完”和恢复时间（下一个 UTC 日，以本地时间显示）。Web 保留提示到恢复时间并自动清除，页面在打开或手动刷新时读取，普通断线重连不清除；控制连接保持。局域网、Tailscale 和电脑上的任务不受影响。打开的连接设备页仅在准备期间每 2 秒刷新。
- 首次开启生成 `<web-data>/remote-relay/identity.pem`（Ed25519 PKCS#8，权限 0600）。身份与公钥派生 ID 由此文件确定，重启、更新沿用同一文件；官方中转据此沿用分配的地址名。页面仅简述本机数据目录中的 `remote-relay/identity.pem`，不显示完整本机绝对路径。不要分享私钥；丢失或删除后可能无法找回旧地址。
- 注册成功后，电脑自动向 Let's Encrypt 申请证书，用经 Relay 转发的 TLS-ALPN-01 连接验证；不需要向电脑开放入站端口。账户私钥 `acme-account.pem`、证书私钥 `certificate-key.pem` 保存在 `remote-relay/`，证书 `certificate.pem` 和签发记录 `certificate-state.json` 按控制地址保存在 `remote-relay/endpoints/<encodeURIComponent(控制地址)>/`，权限 0600；私钥不离开电脑。账户与证书私钥首次生成后沿用，续期只原子替换证书，立即生效，不重启 Web。
- 可用证书必须覆盖当前主机名、处于有效期内、与证书私钥匹配并能构造 TLS 上下文。注册成功和注册期间每小时检查，在实际有效期的 2/3 处续期。续期失败不影响仍可用的旧证书，到期则撤下。没有可用证书时保持注册，只应答本轮证书验证，关闭普通手机连接。
- 失败按 10 分钟、1 小时、6 小时、之后 24 小时的基准退避，每次再加 0–10% 的延迟，并遵守证书机构的 `Retry-After`。等待时间保存在 `certificate-state.json`，重启或断线重连不会提前重试。连续两次验证失败或 CAA 拒绝时暂停；请根据页面的证书机构说明修复后关闭中转再重新启用。重新打开会清除本地失败计数与暂停，但仍遵守 `Retry-After`；Web 重启只解除暂停。
- `CODEXHOST_RELAY_ACME_DIRECTORY` 可覆盖默认的 Let's Encrypt 生产目录，例如使用 staging 或本地测试 CA。更换目录后沿用账户私钥，旧目录的失败记录不适用；不会因此替换仍可用且未到续期时间的证书。staging 证书不被真实手机信任，切到生产前需要移除 staging 证书和失败记录。
- **证书透明日志会公开中转地址。** 不要把地址当作秘密；访问安全依赖令牌。实现采用 TLS-ALPN-01，不做 DNS-01 或备用证书机构自动切换。
- 控制连接出站默认为 WSS 443。`HTTPS_PROXY`（或 `https_proxy`）为 `http://` 代理时使用 CONNECT，仍校验控制地址的 TLS 证书；控制连接暂不支持 `NO_PROXY`、SOCKS 和代理认证。证书机构请求使用 axios 的 `HTTPS_PROXY` / `NO_PROXY` 支持，HTTPS 目标走 CONNECT。
- 连接尝试（含 DNS、CONNECT、TLS、升级及注册）限时 30 秒；60 秒未收到 WebSocket ping 则断开重连。退避从 1 秒倍增到 60 秒，每次随机取上限的 50%–100%；注册稳定 60 秒后重置退避。被替换、签名被拒、版本不支持时停止，不自动争抢身份；处理原因后关闭再打开开关或重启 Web。
- 中转请求始终是非本机 HTTPS；忽略 `x-forwarded-*`，按 Relay 告知的手机 IP 限速。Origin 必须完整匹配该电脑的 HTTPS 来源。响应含 `Strict-Transport-Security: max-age=31536000`，不包含子域。中转 TLS 优先协商 HTTP/2，多路复用同一条连接上的 HTTP 请求；兼容 HTTP/1.1。WebSocket 使用独立的 HTTP/1.1 连接，不启用 HTTP/2 扩展 CONNECT。不宣告 HTTP/3 或 ECH。本机、局域网、Tailscale 与反向代理连接 Web 的 HTTP 端口仍使用 HTTP/1.1。

## 使用自己的域名或隧道

以下方式都需要在命令行配置，配好后页面不提供编辑入口。下面的例子用 `code.example.com`，请替换成你的域名。示例中的 DNS、证书、WebSocket 和事件流需按实际部署环境验证。

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
| Relay 中转 | 电脑上的 Web；中转只转发加密字节 | 电脑；中转方的能力边界见下文 |
| Cloudflare Tunnel | Cloudflare 边缘；之后经加密 Tunnel 到 `cloudflared`，再经回环 HTTP 到 Web | **Cloudflare** 和电脑 |
| nginx | nginx | nginx 管理者和电脑 |
| frp + nginx | 电脑上的 nginx；frps 和 frpc 只转发密文 | 电脑 |

Serve 生效期间，其他回环代理也会被信任，不要把它当成隧道身份认证。

### 中转的信任边界

- 正常转发时，中转方能看到电脑和手机的 IP、子域名、连接时间及流量大小，不能解密内容或替换 TLS 内的页面。
- 控制 DNS 或中转公网 443 入口的一方，有能力自行应答证书验证、为子域申请另一张证书并实施中间人攻击。证书会进入公开的证书透明日志，日志可用于发现冒签，不能事先阻止。因此只能说“中转服务不解密内容”，不能保证“中转方绝对无法读取”。
- 中转地址会进入证书透明日志，不是秘密，也不是访问凭据。访问安全依赖令牌；令牌持有者可以通过终端或 Agent 在电脑上执行命令，本机管理入口不构成对令牌持有者的严格权限隔离。取得电脑控制权后的访问不在此防御范围内。

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

## 电脑离线时打开页面

在 HTTPS 入口登录并打开过界面、Service Worker 已安装的浏览器，之后新开标签页或刷新时，如果网络请求失败、10 秒内没有收到响应头，或网关返回 502/503/504，会显示“正在连接…”加载状态并自动恢复，不把短暂故障显示为电脑不可用。已打开的应用内重连保留现有内容与未发送输入，不由此导航恢复页接管。

- 加载状态提示正在自动重连；浏览器报告断网时提示等待网络恢复。持续 30 秒后补充网络、Web 运行状态的排查提示和当前地址，始终提供“重试”按钮。连接着没有互联网的 Wi-Fi 时，浏览器也可能报告在线，探测仍会继续。
- 立即探测当前页面地址，每次与正常导航一样最多等待 10 秒。失败后按 1、2、4、8、10 秒的间隔重试，之后保持 10 秒；回到前台、网络恢复或点击重试时重置间隔并立即探测。同一时间只保留一个探测，不打断仍在等待的请求。收到非 502/503/504 响应后重新加载，登录失效则进入登录页。后台计时器可能被浏览器放慢。
- 加载期间收到通知的会话跳转消息后，会保留对应的 `?session=` 地址，连接恢复后打开该会话。
- 导航恢复页不加载外部资源，不缓存前端壳、会话列表或历史，不能离线浏览会话。接口和静态资源请求仍走网络；页面响应头返回后的断流或资源加载失败不由此机制处理。

**首次访问时电脑必须在线。** 只打开过登录页还不够，需要登录进入界面。局域网或 Tailscale IP 的普通 HTTP 地址不是安全上下文，没有此离线页；本机 `localhost` / `127.0.0.1` 是例外。

**iOS 限制：** Safari 网站连续七天没有用户交互，Service Worker 注册可能被清除。添加到主屏幕的 Web App 不受这个七天限制，但用户清除数据或存储空间不足仍可能清除它。主屏幕 App 与 Safari 标签页的数据分开，需要各自在线打开并登录一次。Worker 被清除后会显示浏览器自己的错误页，需要联网重新打开界面。

## 技术参考

### HTTP 连接复用

Web 的 HTTP/1.1 空闲保持时间为 120 秒，本机、局域网、Tailscale、反向代理上游和中转共用。该值为 Chrome、Safari 等浏览器的分钟级空闲复用留出时间，同时限制闲置连接占用；浏览器也可能提前回收。HTTP/1.1 请求头与请求体接收期限保持 Node 默认值，不随空闲保持时间延长。中转 HTTP/2 会话在 120 秒无活动后优雅关闭，不中断正在处理的流。

### 地址规则

- **`--public-url`：** 只接受 `http`、`https` 的根地址（可带端口和结尾 `/`），不允许用户信息、路径、查询或片段，无效值使启动失败。HTTP 可用，但以明文传输。它只用于链接和二维码，不会成为可信代理、同源白名单或本机访问。
- **参数来源：** 后台 Web 读取保存的设置，不沿用 Web 环境变量。源码入口 `npm start web -- --public-url ...`、`node preview.mjs --public-url ...` 和直接入口 `node app/server.mjs --public-url ...` 支持参数或 `CODEXHOST_WEB_PUBLIC_URL`，命令行优先；preview 在清理环境前把环境变量转成参数。`--trusted-proxy` 接受逗号分隔的多个 IP；直接入口也接受 `CODEXHOST_WEB_TRUSTED_PROXIES`，preview 使用命令行参数。
- **页面默认选择：** 公开地址、已启用的官方或自建中转（准备中也选中对应卡片以显示状态）、Funnel、Serve HTTPS、Tailscale IP、局域网、虚拟网卡。没有可用入口时优先预览局域网候选地址，否则显示 HTTPS 设置。同一方式有多个地址时提供下拉选择。
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
