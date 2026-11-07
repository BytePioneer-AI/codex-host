# 自建中转

给自己的 codexhost Web 搭一个中转，手机不用装 App。中转只转发加密字节，手机的 TLS 在电脑上解开；服务器只需要控制地址的证书。完整参数见 [Relay README](../../packages/remote-relay/README.md)。

自建中转需要自己的域名，不支持只用 IP。没有域名时，推荐用 [Tailscale](web-remote-access.md#tailscale-https推荐) 或官方中转；能接受 Cloudflare 看到内容时，也可以用 [Cloudflare Tunnel](web-remote-access.md#cloudflare-tunnel)。

## 准备域名和服务器

- 自己的域名、一台公网 TCP 443 空闲的 Linux 服务器，已安装 Git、Docker（含 Compose）和宿主机 certbot。
- 两条 DNS 记录：`relay.example.com`（控制地址）和 `*.r.example.com`（电脑地址），均指向服务器。使用 Cloudflare 时必须选“仅 DNS”，不能开代理。只在 IPv6 同样可达时添加 AAAA 记录。
- 以下示例把仓库放在 `/opt/codexhost`，请把域名和路径换成自己的。服务器防火墙和云安全组需放行 TCP 443；下面的 certbot 申请和续期还需要 TCP 80。

**知道控制地址的人都能注册使用，证书透明日志会公开域名；本示例不提供任何准入功能。** 手机登录仍需要电脑的访问令牌，不要分享登录链接或二维码。

## 部署

### 1. 获取源码

准备好自己的域名和装有 Docker Compose、certbot 的 Linux 服务器后，在服务器上获取公开仓库源码，示例放在 `/opt/codexhost`（需要有该目录的写权限，也可改为自己的目录）：

```sh
git clone https://github.com/BytePioneer-AI/codex-host.git /opt/codexhost
```

### 2. 申请控制地址证书

在服务器上运行，只申请控制地址，不用申请通配符证书；每台电脑会自行申请自己的证书。

```sh
sudo certbot certonly --standalone -d relay.example.com
```

容器使用非 root 用户（UID/GID 1000）。允许穿过 certbot 证书目录，只把控制地址私钥的读取权授予 GID 1000（确保宿主机这个组里的用户也可信），不要把私钥改成所有人可读：

```sh
sudo chmod 755 /etc/letsencrypt/live /etc/letsencrypt/archive
sudo chgrp 1000 /etc/letsencrypt/live/relay.example.com/privkey.pem
sudo chmod 640 /etc/letsencrypt/live/relay.example.com/privkey.pem
```

### 3. 构建镜像

在服务器的仓库根目录运行，不需要先安装 Node.js 或 npm 依赖：

```sh
cd /opt/codexhost
docker build -f packages/remote-relay/Dockerfile -t codexhost-relay:local .
```

镜像由你本地构建，暂不发布到镜像仓库。

### 4. 启动

修改 [`packages/remote-relay/deploy/compose.yaml`](../../packages/remote-relay/deploy/compose.yaml) 中的域名和证书路径，然后在仓库根目录运行：

```sh
docker compose -f packages/remote-relay/deploy/compose.yaml up -d
docker compose -f packages/remote-relay/deploy/compose.yaml logs --tail 50 relay
```

示例把公网 443 映射到容器 8443，避免非 root 进程绑定特权端口；整个 `/etc/letsencrypt` 只读挂载，保留 `live` 到 `archive` 的证书链接。容器异常退出或服务器重启后自动恢复。正常空闲时没有启动日志，控制地址 HTTPS 返回 **404 是正常的**。

可在 Compose 的 `command` 末尾追加参数，例如 `--rate`、`"2000000"`、`--daily-quota`、`"2000000000"`、`--max-connections`、`"200"`（每项单独一行，沿用现有列表格式）。分别限制每地址每方向的字节/秒、每地址 UTC 日双向总字节数、全部 TCP 连接数，默认均不限制。日用量只在内存中，重启会清零；这不是准入或防滥用机制。

### 5. 在电脑上连接

在运行 codexhost 的电脑上打开“设置 → 连接设备”，选择独立的“自建中转”卡片。填写控制地址 `relay.example.com`，只填主机名，不带 `https://`、端口或路径，然后点击“启用中转”，同一步保存地址并开始连接，无需单独保存。卡片中的教程未配置时展开，有控制地址后收起为“如何搭建自己的中转”，可随时展开。

自建中转**不需要邀请码**，页面不显示地址名和邀请码；地址使用电脑公钥派生的 ID，例如 `https://<id>.r.example.com/`。开启后控制地址只读，关闭后才可编辑；访问地址和“复制链接”紧跟状态与开关，教程位于其后。等状态变为“已开启”后用手机扫码。官方与自建同一时间只能开启一个；如另一中转正在使用，须先关闭。更换控制地址前也须关闭，换址不沿用旧分配地址与证书，电脑身份密钥保持不变。

开发时仍可用 `codexhost web --relay relay.example.com` 预填或覆盖自建地址；该选项不改变“codexhost 中转”卡片的官方固定地址 `relay.chost.dev`，也不覆盖页面显式保存的当前类型。普通用户无需运行此命令。更多连接说明见 [Web 远程访问](web-remote-access.md#relay-中转)。

## 证书续期与更新

启用宿主机 certbot 的自动续期定时任务（安装方式不同，任务名称可能不同）。用 deploy hook 在续期成功后更新私钥权限并通知容器重新读证书。把以下内容保存为 `/etc/letsencrypt/renewal-hooks/deploy/codexhost-relay`，按实际情况修改域名和仓库绝对路径：

```sh
#!/bin/sh
set -eu
[ "$RENEWED_LINEAGE" = /etc/letsencrypt/live/relay.example.com ] || exit 0
chgrp 1000 "$RENEWED_LINEAGE/privkey.pem"
chmod 640 "$RENEWED_LINEAGE/privkey.pem"
docker compose -f /opt/codexhost/packages/remote-relay/deploy/compose.yaml kill -s SIGHUP relay
```

```sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/codexhost-relay
sudo certbot renew --dry-run
```

certbot 的 deploy hook 由 root 执行，需要能调用 Docker；`--dry-run` 默认不执行 deploy hook。可在仓库根目录手动验证信号：

```sh
docker compose -f packages/remote-relay/deploy/compose.yaml kill -s SIGHUP relay
docker compose -f packages/remote-relay/deploy/compose.yaml ps
```

SIGHUP 不重启进程、不打断已有连接。先确保新证书与私钥完整、匹配且可读：加载失败会使进程退出，由 Compose 重启，没有旧证书回退。

更新时，在仓库切换到需要的版本后重新构建并替换容器（会短暂断线，电脑自动重连）：

```sh
docker build --pull -f packages/remote-relay/Dockerfile -t codexhost-relay:local .
docker compose -f packages/remote-relay/deploy/compose.yaml up -d --force-recreate
```

## 常见问题

- **443 被占用：** 停止或迁走占用它的服务，不能改用其他公网端口绕过；电脑证书验证必须能直达公网 443。certbot 的 standalone 方式还要求申请、续期时 80 空闲。
- **容器重启或报 `EACCES`：** 检查域名、证书路径和上述目录/私钥权限；不要只挂载 `live` 或单个证书文件，续期后链接会变化。rootless Docker 或启用用户命名空间映射时，需按映射后的宿主机身份另行授予读取权限。
- **控制地址可达但电脑地址不可用：** 检查通配 DNS、443 防火墙和电脑的证书状态。不能经过 CDN 代理或会解开 TLS 的 HTTP 反向代理，中转需要原始 TLS 连接。
- **很多新电脑申请证书失败：** 同一注册域名共享证书机构的新证书限额，详情看连接设备页提示；反复启停不会绕过限额。
