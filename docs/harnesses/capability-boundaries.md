# Harness 能力表的边界

功能表描述 codexhost 当前插件实际可用的能力，不把上游交互终端中的功能自动视为可通过插件调用。各 Harness 使用自己的原生接口；公共 Adapter 契约不承担权限模拟、历史伪造或 Harness 专用协议。

## 各 Harness 的接入方式

- **OMP**：现有原生提问与工具审批已接入。选择题使用原生逐项说明，超时与主动取消分别回传 `timedOut` / `cancelled`，详见 [OMP 交互](omp/omp-interactions.md)。子代理投影依赖 OMP RPC 的 `set_subagent_subscription` 订阅（服务端默认 `off`）：Host 启动连接时请求 `events` 级别；不支持该命令的旧版 OMP 优雅降级为无子代理投影，不阻塞会话。子代理转写读取优先直接读父会话文件旁的 `<子代理ID>.jsonl`（OMP RPC 的子代理注册表仅存于内存，冷启动进程无法按 ID 解析已完成的子代理）；文件不存在时回退 RPC 读取。
- **CodeBuddy**：从 ACP 动态目录读取斜杠命令，按原生压缩事件及持久化结果确认上下文压缩；通过原生附加系统提示让会话发现 Host 委派 CLI。Fork 和修订通过无模型的原生复制、原生 `/fork` 与仅作用于新副本的 rollback 完成，校验完整历史前缀与源会话不变；派生配置随原生引用恢复。成功派生后通过同一临时 ACP 进程的原生 HTTP 接口删除中间副本；早期失败或强杀仍可能残留，详见专属文档。详见 [CodeBuddy 接入](codebuddy/codebuddy-harness-integration.md)。
- **Cursor**：参数化模型目录提供 Thinking 组合；ACP 原生命令目录提供命令；每会话的原生 HTTP MCP 连接提供向外委派。详见 [Cursor 接入](cursor/cursor-cli-experimental.md)。
- **Hermes**：新会话优先使用可用的官方 gateway，不以版本数值差异阻断，接入提问、Thinking、命令、压缩、原生 Diff，以及未压缩历史的独立 Fork/修订；通过进程内注册的私有临时 Skill 发现 Host CLI 并保留父任务环境，不向共享技能目录写入临时 Skill。旧 ACP 引用仍由 ACP 恢复。详见 [Hermes 能力与边界](hermes/hermes-capabilities.md)。

以上实现归各 Harness 插件所有，不在公共 Adapter、Host 或 Renderer 中添加 Harness 专用分支。跨插件参考实现不等于共用原生协议；各自保留配置确认、取消、持久化和权限语义。

## Kimi Thinking 配置

Kimi 通过 ACP `configOptions` 提供当前会话、当前 Model 的 Thinking 列表和选中值。插件在创建、恢复、配置命令响应及 `config_option_update` 通知中读取这些事实，将列表保存在会话内存状态的 `availableThinkingOptions` 中，沿公共状态事件更新 Desktop；不轮询，也不在启动检查时遍历切换 Model。不同会话或 Host 不共享可变列表。

启动检查只读取配置文件中的 Model 目录并检查认证。配置文件不是 Thinking 能力目录，因此草稿目录不猜测 `medium` 或 `off/on`，也不自动发送 Thinking 默认值；未显式选择时保留原生默认配置。会话建立后使用原生列表。切换 Model 以返回的新配置整体替换旧列表，不自动重放旧 Thinking；原生未提供列表时清除旧列表。当前 Model 的选项不扩散到其他 Model。

显式选择或持久化恢复的 Thinking 值不在当前原生列表中时返回错误，不将 `medium` 映射为 `on`，也不静默替换用户选择。应重新选择原生支持的值或清除旧选择。`off/on` 是部分 Model 的原生取值，不是所有 Kimi Model 的固定能力。

## Cursor 剩余边界

Cursor 当前 ACP 没有 Usage、Fork、回滚或上下文压缩出口。macOS/Linux 的 Fork 通过隔离的 CLI 会话副本执行原生 `/fork`，历史位置再用 `/rewind` 的“仅恢复对话”选项回退，最后由 ACP 恢复；修订上一条复用这条路径，包括单轮回退为空会话。会话内容不做格式转换，目标边界必须有原生回退点。Windows Fork/修订和跨工作区 Fork 仍不支持。插件不重写原生消息来合成回滚，也不把普通 `/compact` Prompt 计为压缩。

Agent 间任务协作目前是单向的：正常 Cursor Session 可以通过原生 MCP 向其他 Harness 委派、查询及跟进任务。无人值守入站需要确认原生 Full Access 已生效，但 Cursor 的 `--force` 可能被团队策略静默降级，而 ACP 只公布 Agent/Plan/Ask，不能确认最终审批策略，因此仍返回 `unsupported`。这不同于缺少向外委派能力，能力表分别标明。

## Pi subagent 插件

Pi Adapter 接入 `pi-subagents`（nicobailon）的异步 Host 状态与检查协议，以及同步 workflow 的 `workflowChildren` 摘要，复用公共子 Thread 和渲染链路。异步转写是原生有界窗口；同步 workflow 从父结果定位只读子 Session，文件不可用时可展示明确标注的原生结果摘要。没有已支持身份协议的同步单 Agent 调用及其他同名插件不自动兼容。详见 [Pi subagent 映射](pi/pi-subagents.md)。

## Pi 权限模式

已核对本机 Pi `0.85.1` 的 RPC、get_state 和类型定义，没有原生会话权限模式目录或权限切换入口；其默认工具执行方式不等同于一个可选择的 Permission Mode。`--tools` / `--exclude-tools` 是工具装载过滤，`--approve` 是项目文件信任，均不能冒充统一的只读/询问/完全访问权限策略。

当前插件继续支持原生扩展交互，但不添加一套 Host 自行实现的 Pi 权限引擎。要支持可切换权限模式，需要 Pi 自身或明确安装的原生扩展公布策略、设置入口与生效确认；不能根据另一个 Harness 的权限名称推断 Pi 的行为。

依据：[Pi 官方 README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) 的 Philosophy 与 Extensions，以及本机 `pi --help` / RPC 文档。官方核心不提供 permission popups，允许通过扩展自定义确认流程；permission-gate / plan-mode 扩展示例分别采用命令匹配和工具过滤，不是核心权限模式。

## Antigravity 工具审批与压缩

已核对本机 agy `1.2.5` 的 `--help` 及 `-p /help --output-format json`。headless 输入接受 Prompt，不接受双向工具权限回答；官方说明需要交互批准的操作在 headless 下被 soft-denied。现有插件的 Skip permissions 仍是原生启动选项，官方 PreToolUse Hook 支持 allow/deny/ask 等决策，但它在工具执行前触发，并非原生审批请求/应答通道；headless 中 ask 仍被 soft-denied，不能将 Hook 拦截重建为另一套工具权限策略。提问 Hook 仅用于 ask_question，不等于普通工具审批。Python SDK 的 [ask_user policy](https://antigravity.google/docs/sdk/policies/) 是独立 runtime 的能力，不是已登录 CLI Session 的审批回传入口。

原生 headless 命令目录未公布 `/compact` 或 `/compress`，也没有经验证的压缩命令或自动压缩开始/完成事件。SDK/交互终端中存在压缩实现不能证明当前 CLI Session 暴露等价调用入口。后续需原生 headless/RPC 增加可确认的会话压缩操作与结果，再在 Antigravity 插件内映射为命令与 contextCompaction Item；不发送普通“请总结”Prompt 伪装上下文压缩。当前 Python SDK 的 token_threshold 控制自动阈值，官方[按需压缩请求](https://github.com/google-antigravity/antigravity-sdk-python/issues/63)仍未关闭。

依据：[官方 Hooks 文档](https://antigravity.google/docs/hooks)、[官方 headless 文档](https://antigravity.google/docs/cli/headless/)、[官方权限文档](https://antigravity.google/docs/cli/permissions)、[现有插件权限边界](antigravity/antigravity-tool-approval.md)。此次 `/help` 原生探针返回 num_turns=0，没有发起模型请求。
