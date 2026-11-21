---
title: SSH 远程主机
description: 用本地 Codex Desktop 连接远程 Linux 或 macOS 服务器运行 Agent。
---

# SSH 远程主机

当项目代码、编译工具链和已登录的 Agent CLI（如 Claude Code、Pi）位于远程 Linux 或 macOS 开发机上时，SSH 模式让你在本地 Codex Desktop 里聊天、看 Diff、点审批，而所有 Agent 进程和文件修改都在远程服务器上执行。

## 前置条件

1. **本地电脑**（macOS / Windows / Linux）：已通过 `codexhost` 启动 Codex Desktop。
2. **远程服务器**：系统为 **Linux 或 macOS**（不支持把 Windows 作为 SSH 被控端），已安装 **Node.js 22.19+ 或 24**、npm、官方 Codex CLI，且你要用的外部 Agent CLI 已在远端安装并登录。
3. **SSH 免密连通**：先在本地终端手动运行一次 `ssh user@host`，确认已配置好 SSH 密钥并接受主机指纹（界面复用系统 SSH 配置，不会弹密码输入框）。

## 在设置页一键安装并连接（推荐）

1. 在本地 Codex Desktop 打开 **「codexhost 设置 → 远程连接」**，点击 **「添加连接」**（如果已在官方「设置 → 连接 → SSH」中加过这台机器，会自动显示在列表里）。
2. 填入名称和 SSH 地址（如 `dev@192.168.1.50` 或 `~/.ssh/config` 别名），点击 **「保存」**。
3. 点击 **「安装并连接」**。CodexHost 会通过 SSH 自动在远端安装与本机一致的版本并建立连接。
4. 状态变为 **「已连接」** 后，在 Codex Desktop 打开远端服务器上的项目目录，即可在输入框右下角选择远端服务器上的 Agent。

以后升级了本地的 CodexHost，只需回到「远程连接」页面点击 **「更新到本机版本」** 即可同步升级远端。

## 在远程服务器上手动命令行安装

如果习惯登录服务器用终端安装，确保两端版本一致后，在远程服务器上运行：

```bash
npm install -g @codexhost/cli
codexhost remote install
codexhost remote start
codexhost remote status
```

### 远程机器是 macOS 时读取登录钥匙串

macOS 上的标准 SSH 会话默认可能读不到桌面登录钥匙串（Login Keychain）里的凭证（例如 `gh` CLI 令牌）。只要远程 Mac 保持同一个用户的桌面登录状态，可切换为桌面会话模式：

```bash
codexhost remote stop
codexhost remote install --session desktop
codexhost remote start
```

更多说明见仓库中的 [SSH 远程主机文档](https://github.com/BytePioneer-AI/codex-host/blob/main/docs/platforms/remote/remote-ssh-host.zh-CN.md)。
