---
title: 安装与运行
description: 安装 CodexHost 并管理桌面端、Web 端与后台服务。
---

# 安装与运行

CodexHost 提供三种安装方式：桌面安装包、npm 命令行与 WinGet。

## 安装

### 桌面安装包（macOS / Windows）

从 [GitHub Releases](https://github.com/BytePioneer-AI/codex-host/releases) 下载对应系统的安装包（macOS 为 `.dmg` / `.pkg`，Windows 为安装程序）。

安装后打开 **`codexhost`** 即可启动增强版 Codex Desktop。如需在浏览器中使用 Web 端，直接访问 `http://127.0.0.1:4400`。

### npm（macOS / Windows / Linux）

需要 **Node.js 22.19+** 或 **Node.js 24**（不支持 23.x）：

```bash
npm install -g @codexhost/cli
```

启动与管理命令：

```bash
codexhost          # 启动桌面端（未安装 Codex Desktop 时自动打开 Web 端）
codexhost web      # 启动后台 Web 服务并在浏览器打开 127.0.0.1:4400
codexhost status   # 查看后台服务状态、版本号与自启设置
codexhost stop     # 停止全部后台服务
```

### WinGet（Windows x64 / ARM64）

安装与后续升级均使用同一条命令：

```powershell
winget install --id BytePioneer-AI.CodexHost --exact
```

## 前置条件

| 使用方式 | 要求 |
| :--- | :--- |
| **桌面端界面** | 本机需先安装官方 **Codex Desktop**。 |
| **Web / 手机端界面** | **无需**安装 Codex Desktop，直接运行 `codexhost web` 即可。 |
| **外部 Agent** | 本机需安装并登录对应的 Agent CLI（如 `claude`、`pi`、`grok` 等），也可在「设置 → 连接」页面中检测并一键安装。 |

## 更新、停止与开机自启

```bash
codexhost update            # 升级到最新版本
codexhost stop              # 停止 Desktop、Web、后台 Host 与控制台进程
codexhost autostart on      # 开启系统登录自启
codexhost autostart off     # 关闭系统登录自启
codexhost autostart status  # 查看自启状态
```

- **覆盖安装注意**：若使用 `npm install -g` 手动覆盖安装，请先运行 `codexhost stop`。
- **数据保留**：`codexhost stop` 会中断正在运行的轮次，但不会删除任何聊天记录、工作区文件或配置。

## 桌面端与 Web 端如何共用会话

Codex Desktop 与 Web 端（`127.0.0.1:4400`）连接的是本机同一个后台 Host 进程。

所有会话、工具审批和运行中的任务都保存在后台 Host 中。关闭桌面窗口或关闭浏览器标签页不会打断任务；在桌面端发起的任务可以随时在手机浏览器里查看进度或点击审批。

## 下一步

- [账号与用量](/docs/quick-start/accounts-usage) —— 查看各工具剩余额度、将 Codex / Grok 凭据导入 Pi。
- [故障排查](/docs/quick-start/troubleshooting) —— 用 `codexhost console`（端口 `4399`）排查启动问题。
- [Web 与手机访问](/docs/web/mobile) —— 用手机扫码连接本机 Web 端。
