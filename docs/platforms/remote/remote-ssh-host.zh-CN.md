# 通过 SSH 使用远程 Harness

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

安装会自动备份需要修改的 Shell 配置。在 macOS 上，被控机器还需要保持用户已登录桌面，才能正常启动 Claude Code。

## 使用

1. 在本机通过 codexhost 启动 Codex Desktop。
2. 打开 SSH 工作区。
3. 在输入框的 Agent / Model 选择器中选择目标 Harness。

本地和 SSH 工作区可以同时使用，各自选择对应机器上可用的 Harness 和模型。如果只使用远程原生 Codex，无需在被控机器上安装 codexhost。

## 在两端查看和操作同一外部会话

在被控机器上也安装 Codex Desktop，并通过 codexhost 启动。远程服务运行期间，从 SSH 工作区创建的外部 Harness 会话会自动出现在被控机器的会话列表中，首次出现可能需要几秒。

两端需使用相同版本的 codexhost。被控机器上的桌面登录用户应与 SSH 登录用户一致；如果自定义了 Codex 数据目录（`CODEX_HOME`），两种启动方式也应使用同一目录。

- **同步查看**：两端都能看到用户消息、逐步生成的回复、工具操作和任务状态。
- **随时操作**：任意一端都可以发送、插入消息、中断任务或回答审批与提问，无需切换控制权。
- **同时操作**：任务执行中追加消息使用插入功能；另行启动任务可能提示忙碌。两端回答同一个审批或提问时，以先处理的回答为准。
- **断线恢复**：只要远程服务仍在运行，单端断开不会停止任务。重连后重新打开会话，可以查看期间产生的内容。停止远程服务会结束正在运行的任务。
- **发送失败**：若断线时无法确认消息是否发送成功，重连后先查看会话，再决定是否重发。

此功能适用于从 SSH 工作区创建的外部 Harness 会话。被控机器上单独创建的本地会话和原生 Codex 会话仍按原有方式使用。

## 常用命令

```bash
codexhost remote status     # 查看运行状态和安装完整性
codexhost remote start      # 启动（可重复执行）
codexhost remote stop       # 停止，不影响其他 Codex 进程
codexhost remote uninstall  # 卸载，保留会话关联数据
```

启动、停止或卸载后，需要在 Desktop 中重新连接 SSH 工作区。

## 升级

在两台机器上用相同的包管理器升级到同一版本，然后在被控机器上重新执行 `codexhost remote install` 和 `codexhost remote start`，再重新连接 SSH 工作区。

## 常见问题

- **运行中的原生 Codex 任务无法插入消息**：确认本机 codexhost 已升级，然后重新连接 SSH 工作区再试。
- **`codexhost/harness/inspect is unsupported on this Host connection`**：当前 SSH 连接没有接入 codexhost。确认被控机器已安装并启动相同版本的 codexhost，然后重新连接 SSH 工作区。
- **`remote status` 提示 degraded 或需要重新安装**：重新执行 `codexhost remote install`，再执行 `codexhost remote start`。
- **原生 Codex 请求返回 `Official request failed; retry explicitly`**：重新连接 SSH 工作区后再试。若持续失败，在被控机器上执行 `codexhost remote stop` 和 `codexhost remote start`，然后重连。
- **重连后短暂显示已连接，随即断开**：将两端 codexhost 升级到同一最新版本，按上面的升级步骤重新安装并启动远程服务，再连接 SSH 工作区。
- **被控机器的 GUI 看不到 SSH 会话**：确认两端都通过 codexhost 启动，远程服务正在运行，且登录用户和 Codex 数据目录符合上述要求。等待几秒后重新查看会话列表。
- **看不到某个 Harness**：在被控机器上检查该 Harness 是否已安装并登录，然后在设置中点击「重新诊断连接」。
- **macOS 上安装失败，提示 launchd / `gui/$UID` 错误**：被控机器需要有已登录的图形会话，登录后重新执行 `codexhost remote install`。
