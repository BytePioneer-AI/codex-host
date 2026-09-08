# SSH 远程 Harness Host

Codex Desktop 可以通过原生 SSH 工作流打开另一台机器上的项目。两端都安装 codexhost 后，远程工作区就能使用只安装、只登录在开发机上的 Harness，包括 Claude Code。

这条链路保留 Codex Desktop 原生界面和 SSH 传输，不会把 Claude 登录伪装成 OpenAI 兼容 API；Native Session 仍由远程机器上的 Claude Code 自己维护。

## 前置条件

- 客户端已安装 Codex Desktop 和 codexhost。
- macOS 或 x64/ARM64 Linux SSH 开发机已安装 Codex CLI，以及与客户端相同版本的 codexhost。
- 目标 Harness 已在 SSH 开发机安装并登录。Claude Code 请在开发机完成正常登录，不要把账号文件复制到客户端。
- 启用 codexhost 前，Codex Desktop 原生 SSH 工作区已经可以正常使用。

客户端可以是 Windows。远程 Host 暂不支持 Windows，因为 Codex 当前的远程控制传输使用 Unix socket。

## 在 SSH 开发机安装

```bash
npm install -g @codexhost/cli
codexhost remote install
codexhost remote start
codexhost remote status
```

如果 `codex` 已经指向 OpenCodex 或其他包装器，请显式传入真正的官方 Codex 可执行文件：

```bash
codexhost remote install \
  --stock-codex /absolute/path/to/official/codex \
  --claude-command /absolute/path/to/claude
```

该命令会：

- 把打包的原生 Shim 安装为 `~/.codexhost/remote/bin/codex`。在托管远程环境中，只有精确匹配默认形式的 `app-server --listen unix://` 会启动脱离会话的 listener；Shim 会先等新的 control socket 可连接，再让 Codex Desktop 的后台 SSH bootstrap 返回；
- 把远程 Mapping Store 数据隔离在 `~/.codexhost/remote/data`；
- 在 `.zshenv`、`.bashrc` 或显式指定的 profile 中加入一段带标记的环境配置；该配置仅在 SSH 会话中生效，因此同一台机器上的本地 Shell 和本地 codexhost Desktop 不会继承远程 Host 所有权；对于 `.bashrc`，受 SSH 条件保护的配置会放在 Ubuntu 等 Linux 发行版常见的非交互提前退出判断之前；该配置既设置 `CODEX_INSTALL_DIR`，也为原生入口提供官方 Codex、Node、Host Runtime、数据目录和可选 Claude Code 的绝对路径；
- 修改 profile 前写入带时间戳的备份；
- 记录已安装原生入口的摘要，因此旧版本包内 runtime 被清理后，后续卸载仍可校验该入口；
- 保持原有 `codex` 命令和 OpenCodex 配置不变。

在 macOS 上，`remote install` 还会为当前用户安装名为
`ai.bytepioneer.codexhost.native-harness-broker` 的 LaunchAgent。该 Agent 只允许在已登录的
Aqua 会话中加载，并以绝对路径执行打包的 Node.js 和
`host-runtime.mjs --codexhost-harness-broker`。SSH Background Host 只通过用户私有的 Unix
socket 与本机 broker 通信；仍由 Aqua 会话中的 Claude Code 原生进程读取自己的登录态。
codexhost 不要求输入 Keychain 密码、不运行 `security unlock-keychain`、不读取 OAuth 材料，
也不通过 SSH 传输凭据。

LaunchAgent 使用 `RunAtLoad` 和有界的 launchd 节流，但不使用 `KeepAlive`：持续启动失败会
保持停止，不会形成重试风暴。descriptor 与 socket 位于
`~/.codexhost/harness-broker`，并限制为当前用户访问。plist 只保存 codexhost 已解析并规范化
的 HTTP/HTTPS/SOCKS 代理变量，以及 `NO_PROXY` 和 `NODE_USE_ENV_PROXY`；不会复制 Claude、
Anthropic、OAuth 或任意 SSH 环境变量。含内嵌账号密码的代理 URL 会被拒绝，不会落盘。

可用以下命令单独诊断 broker 生命周期：

```bash
codexhost broker install
codexhost broker status
codexhost broker stop
codexhost broker uninstall
```

npm 包装器会自动传入当前 Node 和打包 Host Runtime 的绝对路径。再次执行 `remote install`
时，即使 plist 未变化，也会受控重启该 LaunchAgent，避免 broker 继续使用内存中的旧版
JavaScript；正在执行的 Claude Harness 请求会在重启期间失败关闭，broker 恢复 ready 后需要
重新连接远程工作区。持久化 Thread 映射与原生历史会保留，但不会跨 broker generation 复用
内存 Session。若当前用户没有 Aqua 控制台会话，或 launchd 拒绝 `gui/$UID`，安装会直接失败，
不会降级为由 Background SSH 进程启动 Claude。

远程 Host 启动 Harness 时会重新解析开发机上的代理环境：已有的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 等变量优先；macOS 再补充静态系统代理配置；Linux 保留其环境变量和 TUN 网络路径。codexhost 不识别具体代理软件，也不会猜测代理端口；没有可解析的代理时会按直连处理。

如果早期候选版安装的是 Shell wrapper，再次运行 `remote install` 会原地迁移该入口。随后运行 `remote start` 即可启动无头 Host，不要求当前 Shell 重新加载 profile。如果目标 socket 被当前用户、安装清单中记录的官方 Codex 默认 listener 占用，该命令会精确终止这棵 listener 进程树后再启动 codexhost；未知 socket owner 绝不会被自动终止。

脱离规则有意保持严格：命令必须只包含一个默认 `--listen unix://`，并且不能同时启用 `--stdio`；重复 listener、`app-server proxy`、stdio、显式自定义 socket 路径和普通 Codex 命令仍保持原来的前台生命周期。如果默认 listener 提前退出，或十秒内没有把 socket 准备好，bootstrap 会失败，不会误报成功。

原地升级期间，socket 初始化仍会跨版本串行。当前 listener 使用每个 owner 独立的寄存器，并在解绑或绑定 control socket 前额外发布一份已加载旧版托管 Shim 也能识别的活跃兼容标记。已失效的旧版共享标记会保留为被动栅栏，不会再通过共享路径删除。

## 从 Codex Desktop 使用

在客户端通过 codexhost 启动 Codex Desktop，打开 SSH 工作区，然后在该远程输入框的 Agent/Model 选择器中选择目标 Harness。模型发现、Thread、Turn、工具、审批和历史都会由 SSH 开发机上的 codexhost 处理。本地 Harness 可用性会始终独立初始化和缓存，因此 SSH 连接不可用时，切回本地输入框不会被远程检查阻塞。

输入框中的 Codex 账号列表、临时账号选择和额度按 Host 隔离；本地账号不会出现在远程输入框中。切换 Host 或更换连接客户端后，旧请求的结果不能覆盖当前输入框。远程没有提供账号管理接口时，保留普通 Codex 入口，不把本地默认账号绑定到远程 Thread；已有会话保持原来的账号归属。

设置 → 会话导入也按同一个当前 Host 隔离。选中远程输入框时，页面只列出和登记 SSH 开发机上保存的 Session，并通过该远程 Host 打开导入后的 Thread。Linux SSH Host 直接执行 Claude 会话发现；受管 macOS Host 通过 Aqua broker 执行，broker 只传递有界会话元数据和经验证的原生身份，不传输 Transcript 正文或凭据。运行状态显示未知时，应先在 Claude 原生客户端中关闭该会话再导入。两台机器需要安装相同 codexhost 版本；升级后重新连接远程工作区，确保远程 runtime 与 broker 提供匹配的导入方法。

原生 Codex 端点明确返回“不支持 `codexhost/thread/inspect`”时，会通过同一 Host 连接的原生 `thread/read` 核对 Thread ID、CLI 版本和 Provider 元数据，排除 codexhost 的外部 Thread 标记；验证成功后保留普通 Codex 和远程原生认证，不创建账号绑定。超时、断线、无效响应或无法确认归属时，Agent 控件显示 `!` 和错误说明，而不是持续显示加载动画；重新聚焦窗口会重试。归属尚未确认时仍阻止提交，不把外部 Harness 或连接故障静默改判为 Codex。

明确不支持的扩展接口只在当前 Host 请求客户端内、按具体接口记录；后续调用在本地返回不支持，不重复发送网络探测，Harness 发现、侧边栏归属和额度查询也不为这种错误安排自动重试。账号接口不支持不会禁用 Harness 接口，某个 Harness 未安装也不会禁用其他 Harness。超时、认证失败和参数错误不会被当作接口不支持。请求客户端、底层桥接或活动连接策略替换后重新判断；正常请求保持并发，不缓存其返回结果。

远程项目中新开的任务仍应保持 draft 状态并允许选择 Agent。当前 Desktop 版本会从活动输入框自身的标记判断身份，因此项目页其他位置的后台/预热会话不会再把新任务误锁成已有 Codex Thread；首个 Turn 提交并完成绑定后，实际 Thread 身份才成为准确信息源。

远程 Claude Code 进程使用开发机上的 cwd 和账号。为了让 Codex Desktop 渲染，提示词、流式输出、工具状态、审批和 Diff 会通过现有 SSH 通道投影；凭据文件不会被转发。

## 诊断与回滚

```bash
codexhost remote start
codexhost remote stop
codexhost remote status
codexhost remote uninstall
```

`start` 可重复执行并启动已安装的无头 Remote Host；`stop` 只停止经过校验的 codexhost listener，不影响其他 Codex 进程。`status` 除了报告运行状态和协议身份，也会报告原生入口、启动配置、runtime 或数据目录缺失/被修改；托管启动配置块只剩一侧标记或存在其他格式损坏时，会返回 degraded，而 install 与 uninstall 仍会拒绝自动改写；遇到会阻塞 bootstrap 的旧 Shell 入口时，也会明确提示重新安装迁移。`uninstall` 会先核对 manifest 中记录的入口摘要，再只移除托管入口、manifest 和启动配置块，并保留 profile 备份及 `~/.codexhost/remote/data`，便于恢复 Thread 映射。卸载后同样需要重新连接远程工作区。

在 macOS 上，`remote status` 还会确认 Aqua broker LaunchAgent 正在运行、plist 仍指向当前安装的
runtime，并且存在非空且仅当前用户可读的 descriptor。`remote uninstall` 会卸载并移除这个受管
LaunchAgent，但不会修改 Claude Code 配置、登录态、Keychain 数据或原生 Session 历史。

远程 Host 不拥有本机 codexhost Launcher 或自动更新控制器。请在两台机器上使用相同的包管理器更新到同一 codexhost 版本，然后重新连接。
