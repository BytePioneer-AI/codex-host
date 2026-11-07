# 自建中转

给自己的 codexhost Web 搭一个中转，手机不用装 App。中转只转发加密字节，手机的 TLS 在电脑上解开；控制地址的证书由中转自动申请和续期。完整参数见 [Relay README](../../packages/remote-relay/README.md)。

自建中转需要自己的域名，不支持只用 IP。没有域名时，推荐用 [Tailscale](web-remote-access.md#tailscale-https推荐) 或官方中转；能接受 Cloudflare 看到内容时，也可以用 [Cloudflare Tunnel](web-remote-access.md#cloudflare-tunnel)。

## 部署

1. 准备一个域名，以及一台装有 Git、Docker（含 Compose）的 Linux 服务器。
2. 在域名的 DNS 设置里添加一条记录：类型选 A，名称填 *，值填服务器的公网 IPv4 地址。使用 Cloudflare 时选择“仅 DNS”。它同时覆盖控制地址 `relay.example.com` 和电脑地址 `<id>.example.com`；已有的 `www`、根域等记录不受影响，通配只覆盖没有独立记录的子域。只在 IPv6 同样可达时添加 AAAA 记录。
3. 服务器防火墙和云安全组放行 TCP 443，并确保没有其他服务占用。证书验证需要从公网直达 443，无需开放 80，也无需安装额外证书工具。
4. 在服务器上运行以下命令，把 `example.com` 换成你的域名。域名写在部署目录的 `.env` 中，[`compose.yaml`](../../packages/remote-relay/deploy/compose.yaml) 会读取它，以后更新时无需重填。示例目录需要写权限，也可换成自己的目录：

   ```sh
   git clone https://github.com/BytePioneer-AI/codex-host.git /opt/codexhost
   cd /opt/codexhost/packages/remote-relay/deploy
   # 将 example.com 替换为你的实际域名
   echo "RELAY_DOMAIN=example.com" > .env
   docker compose up -d --build
   ```

   Compose 从仓库源码构建镜像，无需安装 Node.js，也无需提前构建或从镜像仓库下载 codexhost 镜像。仅映射 TCP 443，容器以非 root 用户运行；控制地址默认 `relay.example.com`。
5. 在运行 codexhost 的电脑上打开“设置 → 连接设备”，选择“自建中转”，依次填写“中转域名”（如 `example.com`，不带 `https://` 和 `relay.`）和“设备名称”（如 `mycomputer`），确认预览中的手机访问地址后点击“启用中转”。中转服务器地址随中转域名显示为 `relay.example.com`；服务器应使用默认的 `relay.<基础域名>` 控制地址。名称留空时使用电脑 ID。

**知道控制地址的人都能注册使用，证书透明日志会公开域名；本示例不提供准入功能。** 手机登录仍需要电脑的访问令牌，不要分享登录链接或二维码。

自建中转不需要邀请码；地址为 `https://mycomputer.example.com/`，名称留空则由电脑公钥派生为 `https://<id>.example.com/`。CLI 将地址名与电脑身份绑定，保存在 `/data/names.json`，重连和重启不释放；名称被其他身份占用时拒绝注册。控制地址与其他电脑的公钥派生 ID 不可抢占。官方与自建同一时间只能开启一个。

开发时可用 `codexhost web --relay relay.example.com` 预填或覆盖自建地址，不改变官方固定地址或页面显式保存的当前类型。普通用户无需此命令。更多连接说明见 [Web 远程访问](web-remote-access.md#relay-中转)。

## 证书与数据

中转通过 TLS-ALPN-01 在 443 自动申请 Let's Encrypt 控制地址证书，不申请通配符证书；每台电脑仍自行申请自己的证书。中转和用户连接不能经过会终止 TLS 的 HTTP 反向代理或 CDN。

容器的 `/data` 由 Compose 的 `relay-data` 数据卷持久化，存放 `acme-account.pem`、`certificate-key.pem`、`certificate.pem` 和地址名绑定文件 `names.json`。私钥权限为 0600，重启复用密钥与有效证书；不要删除数据卷或分享私钥。首次签发完成前控制连接不可用。

中转与电脑的证书申请请求保留 IPv4/IPv6 自动选择，地址族切换等待为 2 秒，请求总超时为 30 秒。网络错误保留原始错误码，不会被没有 HTTP 响应的错误处理覆盖。

中转每 15 分钟检查，在证书实际有效期的 2/3 处自动续期并立即替换，无需重启。失败后约 15 分钟自动重试，重启容器会立即重试；仍有效的旧证书继续使用，到期后拒绝新的普通控制连接。错误可用 `docker compose logs --tail 50 relay` 查看。Let's Encrypt 有频率限制，反复删除数据或更换域名可能触发限制。

已有证书时，可成对提供 `--cert`、`--key` 并挂载可读的 PEM 证书链及私钥，此时不自动申请；需要续期后重新加载时，向 Relay 进程发送 `SIGHUP`，已有连接不受影响。显式 `--control-host` 可覆盖默认控制地址；不在通配 DNS 范围内时需另加解析记录。

## 限额与更新

可在 Compose 的 `command` 中追加 `--rate`、`--daily-quota`、`--max-connections`，分别限制每地址每方向的字节/秒、每地址 UTC 日双向总字节数及全部 TCP 连接数，默认均不限制。日用量只在内存中，重启会清零；这不是准入或防滥用机制。

更新源码到需要的版本后，在部署目录运行：

```sh
docker compose up -d --build
```

替换容器会短暂断线，电脑自动重连；证书数据卷保持不变。容器异常退出或服务器重启后自动恢复。控制地址 HTTPS 返回 **404 是正常的**。

## 常见问题

- **中国大陆服务器的域名备案：** 服务器在中国大陆时，域名须先在该云厂商完成备案，否则访问 443 的 HTTPS 连接会在握手时被重置，表现为页面提示无法连接中转。也可以改用中国大陆以外的服务器。
- **页面提示无法连接中转：** 客户端会自动重试，并在后续尝试中保留提示。检查控制地址 DNS、公网 TCP 443，以及 `docker compose logs --tail 50 relay` 中的控制地址证书签发错误；控制地址证书尚未签发时无法建立控制连接。
- **证书请求报 `ETIMEDOUT` / `ENETUNREACH`：** 检查服务器到证书机构的出站 HTTPS 和 IPv6 路由。连接地址切换等待与请求总超时不同；无需为解决出站连接问题修改中转公网端口，也不要删除证书数据卷。
- **443 被占用或验证失败：** 迁走占用服务，检查 DNS、CAA、云安全组和防火墙。不能改用其他公网端口绕过证书验证；Cloudflare 必须为“仅 DNS”。
- **数据写入报 `EACCES`：** 使用示例命名卷；改用宿主机目录时，需让容器用户（UID/GID 1000）可写。不要把私钥改为所有人可读。
- **控制地址可达但电脑地址不可用：** 检查通配 DNS、443 和电脑证书状态，确认目标没有指向其他服务器的独立记录。中转需要原始 TLS 连接，不支持终止 TLS 的代理、QUIC/HTTP/3 或 ECH。
- **很多新电脑申请证书失败：** 同一注册域名共享证书机构的新证书限额，详情看连接设备页提示；反复启停不会绕过限额。
