---
title: Self-Hosted Relay
description: Deploy an end-to-end encrypted Web Relay on your own domain and Linux server with Docker Compose.
---

# Self-Hosted Relay

For everyday mobile access, the built-in **Official Encrypted Relay** or **Tailscale** in **Settings → Connected Devices** works without any server setup.

Self-hosting is for when you **already own a domain and a public Linux server** and want a custom URL (such as `https://my-mac.example.com`) on infrastructure you control.

## How encryption works

The Relay server **only forwards raw encrypted TLS bytes**. Your local computer requests its own Let's Encrypt certificate, keeps the private key locally, and decrypts HTTPS traffic on the host itself—the Relay server never holds your private key and cannot read your chats or code.

## Prerequisites

1. **Public Linux server**: Git and Docker (with Docker Compose) installed, and **TCP port 443** open in your firewall and cloud security group (port 80 is not needed, and nothing else may bind to port 443).
2. **Wildcard DNS record**: Add an `A` record in your DNS provider:
   - **Type**: `A`
   - **Name / Host**: `*` (existing `@` or `www` records stay untouched)
   - **Value**: Your server's public IPv4 address (on Cloudflare DNS, set proxy status to **DNS only / grey cloud**)

## Deploy and connect

### 1. Start the Relay on your server

SSH into your server, replace `example.com` with your domain, and run:

```bash
git clone https://github.com/BytePioneer-AI/codex-host.git /opt/codexhost
cd /opt/codexhost/packages/remote-relay/deploy
echo "RELAY_DOMAIN=example.com" > .env
docker compose up -d --build
```

Docker Compose builds from source (no Node.js needed on the host) and automatically provisions the control-plane certificate on port 443.

### 2. Enable it on your computer

1. Open CodexHost Web on your computer (`codexhost web`) and go to **Settings → Connected Devices**.
2. Select **Self-Hosted Encrypted Relay**.
3. Enter your **Relay domain** (e.g. `example.com`, without `https://` or `relay.`) and a **Device name** (e.g. `my-mac`).
4. Click **Enable Relay**. Once your computer provisions its certificate, scan the QR code on your phone to connect at `https://my-mac.example.com`.

For rate limits, connection caps, and troubleshooting, see [self-hosted-relay.md](https://github.com/BytePioneer-AI/codex-host/blob/main/docs/product/self-hosted-relay.md).
