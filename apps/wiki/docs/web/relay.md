---
title: 自建 Relay
description: 在自有域名与 Linux 服务器上用 Docker Compose 部署端到端加密的远程中转服务。
---

# 自建 Relay

日常手机远程访问直接使用「设置 → 连接设备」里的**官方加密中转**或 **Tailscale** 即可，不需要自建。

只有当你**已经有自己的域名和公网 Linux 服务器**，希望使用专属域名（例如 `https://my-mac.example.com`）并自己掌控转发服务时，才需要部署自建 Relay。

## 加密原理

Relay 服务器只负责**原样转发加密后的 TLS 字节流**。HTTPS 证书由你家里的电脑自己向 Let's Encrypt 申请，私钥保存在你自己的电脑上并在本地解密——中转服务器没有私钥，看不到聊天内容或代码明文。

## 准备工作

1. **一台公网 Linux 服务器**：已安装 Git 和 Docker（带 Docker Compose），并在防火墙与云安全组放行 **TCP 443 端口**（不需要开 80 端口，且 443 不能被 nginx 等其他程序占用）。
   > 如果服务器位于中国大陆境内，域名必须先完成 ICP 备案，否则 443 端口会被阻断。
2. **一条通配 DNS 解析记录**：在你的域名 DNS 后台添加一条 `A` 记录：
   - **类型**：`A`
   - **主机记录（Name）**：`*`（不影响已有的 `@` 或 `www` 记录）
   - **记录值（Value）**：服务器的公网 IPv4 地址（Cloudflare 用户需关掉橙色代理云朵，设为 **仅 DNS / Grey cloud**）

## 部署与连接

### 1. 在服务器上启动 Relay

SSH 登录服务器，把 `example.com` 换成你的域名：

```bash
git clone https://github.com/BytePioneer-AI/codex-host.git /opt/codexhost
cd /opt/codexhost/packages/remote-relay/deploy
echo "RELAY_DOMAIN=example.com" > .env
docker compose up -d --build
```

Docker Compose 会直接从源码构建并启动服务（宿主机不需要装 Node.js），同时自动管理控制面证书。

### 2. 在电脑上启用中转

1. 打开电脑上的 Web 端（`codexhost web`），进入 **「设置 → 连接设备」**。
2. 选择 **「自建加密中转」**。
3. **中转域名**填根域名（如 `example.com`，不要带 `https://` 或 `relay.`），**设备名称**填子域名前缀（如 `my-mac`）。
4. 点击 **「启用中转」**。等待约半分钟证书签发完成后，用手机扫码即可通过 `https://my-mac.example.com` 访问。

关于速率限制、连接数上限与证书排错，详见仓库中的 [自建中转文档](https://github.com/BytePioneer-AI/codex-host/blob/main/docs/product/self-hosted-relay.md)。
