# SSH 远程 Harness Host

通过 Codex Desktop 原生 SSH 工作区，在本机使用只安装、只登录在被控机器上的 Harness（包括 Claude Code）。凭据始终留在被控机器上，不会通过 SSH 转发。

## 前置条件

- 本机：已安装 Codex Desktop 和 codexhost，系统可以是 macOS、Linux 或 Windows。
- 被控机器：macOS 或 x64/ARM64 Linux（暂不支持 Windows），已安装 Codex CLI 和**与本机相同版本**的 codexhost。
- 目标 Harness 已在被控机器上安装并登录。
- Codex Desktop 原生 SSH 工作区已能正常使用（**设置 → 连接 → SSH**）。

## 安装

在被控机器上执行：

```bash
npm install -g @codexhost/cli
codexhost remote install
codexhost remote start
codexhost remote status
```

`remote install` 只在 SSH 会话的 Shell 配置中加入一段带标记的配置（修改前会自动备份），不影响本地 Shell 和原有 `codex` 命令。在 macOS 上还会安装一个当前用户的 LaunchAgent，用于在登录会话中启动 Claude Code；它不读取 Keychain 或任何凭据。

## 使用

1. 在本机通过 codexhost 启动 Codex Desktop。
2. 打开 SSH 工作区。
3. 在输入框的 Agent / Model 选择器中选择目标 Harness。

## 常用命令

```bash
codexhost remote status     # 查看运行状态和安装完整性
codexhost remote start      # 启动（可重复执行）
codexhost remote stop       # 停止，不影响其他 Codex 进程
codexhost remote uninstall  # 卸载，保留 Thread 映射数据
```

启动、停止或卸载后，需要在 Desktop 中重新连接 SSH 工作区。

## 升级

在两台机器上用相同的包管理器升级到同一版本，然后在被控机器上重新执行 `codexhost remote install` 和 `codexhost remote start`，再重新连接 SSH 工作区。

## 常见问题

- **`codexhost/harness/inspect is unsupported on this Host connection`**：当前 SSH 连接没有接入 codexhost。确认被控机器已安装并启动相同版本的 codexhost，然后重新连接 SSH 工作区。
- **`remote status` 提示 degraded 或需要重新安装**：重新执行 `codexhost remote install`，再执行 `codexhost remote start`。
- **看不到某个 Harness**：在被控机器上检查该 Harness 是否已安装并登录，然后在设置中点击「重新诊断连接」。
- **macOS 上安装失败，提示 launchd / `gui/$UID` 错误**：被控机器需要有已登录的图形会话，登录后重新执行 `codexhost remote install`。
