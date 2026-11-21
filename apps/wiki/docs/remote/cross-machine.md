---
title: 模式对比
description: 分清什么时候用 Web 手机访问、SSH 远程主机或 Windows 远程控制。
---

# 模式对比

CodexHost 提供三种跨设备使用方式，取决于你的**代码和 Agent 实际跑在哪台机器上**：

| 模式 | 操作界面在哪 | Agent 跑在哪台机器 | 代码与凭证留在哪 | 指南 |
| :--- | :--- | :--- | :--- | :--- |
| **本机桌面端** | 当前电脑的 Codex Desktop | 当前电脑 | 当前电脑 | [安装与运行](/docs/quick-start/install) |
| **Web 与手机访问** | 手机、平板或任意浏览器 | **主力电脑**（与桌面端共用） | **主力电脑** | [Web 与手机访问](/docs/web/mobile) |
| **SSH 远程主机** | 本地电脑的 Codex Desktop | **远程 Linux / macOS 服务器** | **远程 Linux / macOS 服务器** | [SSH 远程主机](/docs/remote/ssh) |
| **Windows 远程控制** | 控制端电脑的 Codex Desktop | **被控 Windows 电脑** | **被控 Windows 电脑** | [Windows 远程控制](/docs/remote/remote-control) |

## 怎么选

- **代码和 Agent 都在你办公桌这台电脑上，只是出门想用手机或平板看进度、发消息**
  用 **[Web 与手机访问](/docs/web/mobile)**。扫码即连，不需要配任何远程主机。
- **手头用轻薄本，但项目仓库、开发环境和 Agent 全在远程 Linux 或 macOS 开发机上**
  用 **[SSH 远程主机](/docs/remote/ssh)**。本地用原生 Codex Desktop 界面，Agent 进程在远端服务器执行。
- **代码和 Agent 装在另一台 Windows 台式机上，想从手头电脑直接调用又不想配 SSH 或端口映射**
  用 **[Windows 远程控制](/docs/remote/remote-control)**，输配对码直接连接。
