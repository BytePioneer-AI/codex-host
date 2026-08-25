# Remote Control 远程 Harness Host

Codex Desktop 官方 Remote Control 可以在不使用 SSH 的情况下，把 Windows 工作区提供给另一台已配对的 Codex Desktop。两端都通过同一个 codexhost 版本启动后，控制端可以选择只安装、只登录在被控 Windows 机器上的 Harness。

这项集成目前属于实验能力。配对、账号认证、relay、环境发现和原生 app-server 协议仍由 OpenAI 官方 Remote Control 负责；codexhost 不替换 relay，也不会新增 TCP 监听端口。

## 使用条件

- 被控 Host 为 Windows；目前已验证的控制端为 macOS。
- 两台电脑安装相同版本的 codexhost，并都通过 codexhost 启动 Codex Desktop。
- 两端登录 Codex Remote Control 所要求的 ChatGPT 账号，先完成官方配对。codexhost 不会绕过账号或设备授权。
- 目标 Harness 已在被控 Windows 上安装并登录；Harness 凭据始终留在 Windows 上。

## 连接步骤

1. 在 Windows 打开 **设置 → 连接 → 控制此电脑**，启用访问并生成配对码。
2. 在控制端打开 **设置 → 连接 → 控制其他设备**，输入配对码并选择 Windows 环境。
3. 打开该环境中的项目，在输入框的 Agent/Model 选择器中选择 Windows 上可用的 Pi、Claude Code、Grok 或其他 Harness。

诊断 Harness 前，先确认原生 Codex 任务可以通过 Remote Control 正常运行。配对失败、环境缺失和账号授权错误属于官方 Remote Control 层。

## 传输与安全边界

官方 relay 只接受原生 app-server 方法，会拒绝 `codexhost/harness/inspect` 这类私有方法。codexhost 因此使用官方允许的 `process/spawn`、`process/writeStdin`、`process/kill`、`process/outputDelta` 和 `process/exited`，承载自己的 LF 分隔 app-server 数据流：

1. 被控端 Host Runtime 把当前随机管道标识和打包运行时的绝对路径原子发布到 `%LOCALAPPDATA%\\codexhost\\remote-control-bridge-v1.json`。
2. 控制端通过已经认证的 Remote Control app-server 连接，启动一个固定的打包桥命令。该命令只读取当前描述文件，不接受请求传入的路径或命令。
3. 桥进程连接到当前 Host Runtime 持有的当前用户级 Windows 命名管道；它不监听任何网络接口。
4. 命名管道上的 Host 会话共享被控端的 Mapping Store 和 Harness adapters。与外部 Harness 无关的原生 Codex 请求仍直接走官方 app-server。
5. 提示词、流式输出、工具状态、审批和 Diff 作为协议投影经过官方 relay；Harness 账号文件和项目文件不会复制到控制端。

Codex 官方把 `process/spawn` 定义为不进入 Codex 命令沙箱的独立宿主进程。codexhost 不会把这项能力暴露给提示词，也不接受任意命令：renderer 策略只能启动固定的打包桥命令。当前用户描述文件只包含 owner PID、随机管道标识以及 Node/Host Runtime 绝对路径，不包含凭据；每次 Host Runtime 启动都会原子替换它，并且只有 owner PID 仍存活时才会使用。项目工具仍由所选 Harness 的原生权限模式约束。

## 诊断

- `unknown variant codexhost/harness/inspect`：私有请求被直接发给了原生 app-server。升级并重启两端 codexhost，再重新连接 Remote Control 环境，让桥接策略完成注入。
- `process/spawn` 或桥启动失败：确认 Windows Codex Desktop 是通过 codexhost 启动的、两端版本都包含 Remote Control Host 支持，并检查 `%LOCALAPPDATA%\\codexhost\\remote-control-bridge-v1.json` 中的 owner PID 仍存活、打包路径为绝对路径；重启被控端后再重新连接该环境。
- Windows 重启后桥初始化超时：重试刚才失败的操作。桥如果在 15 秒内没有完成 app-server 初始化，codexhost 会放弃它；下一次请求会读取当前运行时描述并启动一条新桥。
- 原生 Codex 可用但看不到 Harness：先在控制端运行 codexhost 连接诊断，再检查 Windows 上 Harness 的安装和登录状态。
- `Claude inbound is disabled`：请求已经到达被控 Windows 的 codexhost，但该机关闭了 Claude Code 集成；请先在 Windows codexhost 的界面或配置中启用 Claude，再重试。
- 环境出现前配对就失败：请使用官方 Remote Control 要求的 ChatGPT 账号完成设备授权；这不属于 codexhost 桥接范围。
