---
title: Web & Mobile
description: Serve the bundled Web UI locally and connect from your phone or remote browser via QR code.
---

# Web & Mobile

CodexHost includes a standalone browser Web UI that connects to the same background Host as Codex Desktop while using less memory. As long as your computer is awake and online, you can monitor threads, approve tool calls, and send messages from your phone, tablet, or another laptop.

## Start the Web UI

```bash
codexhost web
```

This starts the Web service in the background on `http://127.0.0.1:4400` and opens your browser. Closing the terminal window or browser tab does not stop the Web server or interrupt running tasks; run `codexhost stop` when you want to shut it down.

## Connect a phone or another device

In the Web UI on your computer, click **Remote Access** in the sidebar (or **Settings → Connected Devices**), pick a connection mode, and scan the QR code with your phone camera:

| Mode | Best for | Encryption | Requirements |
| :--- | :--- | :---: | :--- |
| **Official Encrypted Relay (Recommended)** | Reaching your computer from outside your network without installing apps on your phone | HTTPS (decrypted only on your computer) | None—click **Enable Relay** |
| **Tailscale HTTPS (Recommended)** | Private cross-network access restricted to your own tailnet devices | HTTPS | Tailscale installed on both computer and phone |
| **Same Wi-Fi (LAN)** | Quick access on a trusted home or office Wi-Fi | Plain HTTP | Phone and computer on the same LAN |
| **Self-Hosted Relay / Tunnel** | Running on your own domain and Linux server | HTTPS | See [Self-Hosted Relay](/en/docs/web/relay), or use Cloudflare Tunnel / nginx / frp |

::: warning Security
**Security**: Both the QR code (blurred until clicked) and the copied login link contain your **access token**, which grants full access to your agents. Never share unredacted QR codes or tokenized links, and never expose `--no-auth` on an untrusted network.
:::

## Web & mobile features

- **Home-screen PWA & push notifications**: Add the Web app to your phone's home screen, then enable push alerts under **Settings → General → App & Notifications** to get notified when a turn finishes or needs approval.
- **Nested delegation tree**: Child threads spawned with `#` nest under their parent thread in the sidebar.
- **Select text to quote**: Highlight any part of an agent's reply to quote it directly into your next prompt.
- **Desktop screenshot & browser stream**: Grab an on-demand screenshot of your computer's desktop, or stream a server-side browser view in the right sidebar.
- **Web UI extensions**: Install and toggle frontend/backend Web UI plugins.
