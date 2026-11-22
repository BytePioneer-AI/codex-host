---
title: 故障排查
description: 用本地控制台（端口 4399）诊断启动问题、安装 Agent CLI 并导出日志。
---

# 故障排查

当 Codex Desktop 打不开，或者打开后看不到外部 Agent 选择器时，在终端运行：

```bash
codexhost console
```

这会在浏览器打开 `http://127.0.0.1:4399/`（仅本机可访问，无需登录）。Windows 用户也可从「开始菜单 → codexhost console」打开。

**即使 Codex Desktop 无法启动，本地控制台也能独立运行**：

- **总览**：显示当前 CodexHost 版本、Codex Desktop 版本，以及最近一次启动或注入失败的具体阶段与报错原文。
- **导出诊断包**：点击「导出诊断包（含日志）」可打包运行日志（自动将个人主目录路径替换为 `~`），用于提交 Issue。
- **连接**：查看本机已检测到哪些 Agent CLI、哪些尚未安装或登录，支持在页面上直接点击安装或更新。
- **更新与远程连接**：在 Codex Desktop 关闭时直接更新 CodexHost、配置手机远程访问或管理 SSH 主机。

::: info 说明
端口 `4399` 是诊断与设置控制台；如需在浏览器中与 Agent 对话，请运行 `codexhost web`（端口 `4400`）。
:::

## 常见问题

### macOS 首次启动提示「无法验证开发者」或「应用已损坏」

macOS Gatekeeper 默认会拦截未公证的应用包。在终端移除隔离属性后重新打开：

```bash
xattr -dr com.apple.quarantine /Applications/codexhost.app
```

### 输入框右下角找不到某个 Agent

打开「codexhost 设置 → 连接」（或运行 `codexhost console` 查看连接页）。CodexHost 不打包第三方 Agent 本体，需先在本机安装对应的 CLI（如 `claude`、`pi`、`agy`）并完成登录。连接页会直接给出缺失工具的一键安装入口。

### Windows 使用解压版 Codex Desktop 提示找不到程序

如果 Codex Desktop 解压在自定义目录，需要设置 `CODEXHOST_INSTALL_ROOT` 指向该目录：

```powershell
[Environment]::SetEnvironmentVariable("CODEXHOST_INSTALL_ROOT", "D:\CodexPortable", "User")
```

设置后**完全退出** Codex Desktop，重新打开一个新终端窗口再运行 `codexhost`。

### 查看后台服务状态

```bash
codexhost status
```

只读检查，不会启动或重启任何服务，直接输出 Host、Web、版本号和开机自启状态。

### 卸载前清理

- **Windows 安装包**：直接运行系统卸载程序，会自动停止后台服务并移除登录自启。
- **macOS 应用或 npm 安装**：删除应用或执行 `npm uninstall -g @codexhost/cli` 前，先停止服务并关闭自启：
  ```bash
  codexhost stop
  codexhost autostart off
  ```

## 本地文件与隐私

会话映射、日志和配置默认存放在 `~/.codexhost`，不会上传代码或对话内容。详见仓库中的 [PRIVACY.md](https://github.com/BytePioneer-AI/codex-host/blob/main/docs/PRIVACY.md)。
