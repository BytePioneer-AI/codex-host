# Remote Control 远程 Harness Host（实验）

通过 Codex Desktop 官方 Remote Control，在另一台电脑上使用只安装、只登录在被控 Windows 上的 Harness。不需要 SSH，不新增网络端口，Harness 凭据和项目文件始终留在 Windows 上。

## 前置条件

- 被控机器为 Windows；目前已验证的控制端为 macOS。
- 两台电脑安装相同版本的 codexhost，并都通过 codexhost 启动 Codex Desktop。
- 两端已登录 Remote Control 要求的 ChatGPT 账号，并完成官方配对。
- 目标 Harness 已在 Windows 上安装并登录。

## 连接步骤

1. 在 Windows 上打开 **设置 → 连接 → 控制此电脑**，启用访问并生成配对码。
2. 在控制端打开 **设置 → 连接 → 控制其他设备**，输入配对码并选择 Windows 环境。
3. 打开该环境中的项目，在输入框的 Agent / Model 选择器中选择目标 Harness。

## Desktop 兼容与重连

支持 Renderer 管理会话和主进程 RPC 管理会话两种 Desktop 布局。对于 RPC 布局，codexhost 复用 Desktop 已加载的原生 Manager、RPC 和界面控制器契约，保留历史、通知、跟进队列和审批回调。契约缺失或有歧义时保留原生 Codex 路由，不启用未经验证的 Harness 路由。

只有被控机器返回 Windows 格式的 Codex home 后才启用外部 Harness 桥接。连接 Linux、macOS 的原生 Remote Control 继续使用官方 Manager；这不代表支持被控 POSIX 机器的外部 Harness。

物理连接断开时，即使 Desktop 复用原生 Manager 对象，也会释放旧桥接。重连后建立新的进程桥接，不重放已提交的 Turn。恢复原 Thread 可保留 Harness 归属和原生会话历史。隧道写入和清理独立使用原始 RPC 传输，不经过逻辑请求队列，避免模型、历史请求占满队列后阻塞自己的响应。

## 常见问题

先确认原生 Codex 任务能通过 Remote Control 正常运行。配对失败、环境缺失、账号授权错误都属于官方 Remote Control，与 codexhost 无关。

- **`unknown variant codexhost/harness/inspect`**：升级并重启两端 codexhost，再重新连接 Remote Control 环境。
- **桥接启动失败或 `no active process for process handle`**：确认 Windows 上的 Codex Desktop 是通过 codexhost 启动的，重启被控端后重新连接环境。
- **Windows 重启后初始化超时**：直接重试刚才的操作。
- **原生 Codex 可用但看不到 Harness**：在控制端运行连接诊断，再检查 Windows 上 Harness 的安装和登录状态。
- **`Claude inbound is disabled`**：Windows 上的 codexhost 关闭了 Claude Code 集成，启用后重试。
