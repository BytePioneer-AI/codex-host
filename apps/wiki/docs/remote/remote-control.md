---
title: Windows 远程控制
description: 用配对码从手头电脑远程使用另一台 Windows 主机上的 Agent（实验性）。
---

# Windows 远程控制

如果项目和 Agent 环境配在另一台 Windows 台式机上，想从手头电脑（例如 Mac 笔记本）直接调用它上面的 Agent，又不想配 SSH 或端口映射，可以使用实验性的 **Remote Control** 模式。

该模式直接复用 Codex Desktop 官方自带的 Remote Control 通道：

- 不需要开放任何防火墙或公网端口。
- API Key、Agent 登录态和代码文件全部留在被控的 Windows 电脑上。

## 前置条件

- 两台电脑安装**相同版本**的 CodexHost，且**两边都必须通过 `codexhost` 启动 Codex Desktop**。
- 两边登录官方 Remote Control 要求的 ChatGPT 账号。
- 要使用的外部 Agent（Claude Code、Pi、Grok 等）已在被控 Windows 电脑上安装并登录。

## 连接步骤

1. **在被控 Windows 电脑上**：打开 Codex Desktop **「设置 → 连接 → 控制此电脑」**，开启访问权限并复制屏幕上的**配对码**。
2. **在控制端电脑上**：打开 Codex Desktop **「设置 → 连接 → 控制其他设备」**，输入配对码并选中该 Windows 环境。
3. **打开项目**：在控制端打开 Windows 上的项目目录，即可在输入框右下角选择那台 Windows 上已安装的各个 Agent。

## 故障排查

- **先测原生 Codex 会话**：如果连原生 Codex 消息都发不出去，说明官方 Remote Control 配对本身未连通，请重新配对。
- **检查被控端启动方式**：Windows 上的 Codex Desktop 必须通过 **`codexhost`** 启动。如果直接双击原版 Codex 图标打开，不会加载外部 Agent 支持——完全退出后用 `codexhost` 重新启动。
- **保持两端版本一致**：若报错提示未知方法（Unknown Method），在两台电脑上运行 `codexhost update` 升到同一版本后重连。

详见仓库中的 [Remote Control 文档](https://github.com/BytePioneer-AI/codex-host/blob/main/docs/platforms/remote/remote-control-host.zh-CN.md)。
