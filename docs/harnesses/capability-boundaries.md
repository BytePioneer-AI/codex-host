# Harness 能力表的边界

功能表描述 codexhost 当前插件实际可用的能力，不把上游交互终端中的功能自动视为可通过插件调用。各 Harness 使用自己的原生接口；公共 Adapter 契约不承担权限模拟、历史伪造或 Harness 专用协议。

## 各 Harness 的接入方式

- **OMP**：现有原生提问与工具审批已接入。选择题使用原生逐项说明，超时与主动取消分别回传 `timedOut` / `cancelled`，详见 [OMP 交互](omp/omp-interactions.md)。子代理投影依赖 OMP RPC 的 `set_subagent_subscription` 订阅（服务端默认 `off`）：Host 启动连接时请求 `events` 级别；不支持该命令的旧版 OMP 优雅降级为无子代理投影，不阻塞会话。子代理转写读取优先直接读父会话文件旁的 `<子代理ID>.jsonl`（OMP RPC 的子代理注册表仅存于内存，冷启动进程无法按 ID 解析已完成的子代理）；文件不存在时回退 RPC 读取。
  OMP 的 `/context` 及原生明确报告未调用 Agent 的动态命令使用非持久化完成语义，显示原生文本后释放当前轮次，不合成历史身份；普通轮次的终结与取消检查保持不变。首次本地命令不产生历史文件时，以原生空消息确认下一轮可继续。详见 [本地命令边界](omp/omp-interactions.md#不调用-agent-的本地命令)。
- **CodeBuddy**：从 ACP 动态目录读取斜杠命令，按原生压缩事件及持久化结果确认上下文压缩；通过原生附加系统提示让会话发现 Host 委派 CLI。Fork 和修订通过无模型的原生复制、原生 `/fork` 与仅作用于新副本的 rollback 完成，校验完整历史前缀与源会话不变；派生配置随原生引用恢复。成功派生后通过同一临时 ACP 进程的原生 HTTP 接口删除中间副本；早期失败或强杀仍可能残留，详见专属文档。详见 [CodeBuddy 接入](codebuddy/codebuddy-harness-integration.md)。
- **Cursor**：参数化模型目录提供 Thinking 组合；ACP 原生命令目录提供命令；原生 shell 通过 Host 安装的 `codexhost-delegation` skill 调用 CLI 向外委派。详见 [Cursor 接入](cursor/cursor-cli-experimental.md)。
- **Hermes**：会话统一使用官方 Gateway，不以版本数值差异阻断，接入提问、Thinking、命令、压缩、原生 Diff，以及未压缩历史的独立 Fork/修订；通过进程内注册的私有临时 Skill 发现 Host CLI 并保留父任务环境，不向共享技能目录写入临时 Skill。不再保留 ACP 实现或 SDK 依赖；历史发现和导入使用原生 SessionDB 只读查询，导入的原生身份通过 Gateway 恢复。详见 [Hermes 能力与边界](hermes/hermes-capabilities.md)。

以上实现归各 Harness 插件所有，不在公共 Adapter、Host 或 Renderer 中添加 Harness 专用分支。跨插件参考实现不等于共用原生协议；各自保留配置确认、取消、持久化和权限语义。

## Kimi 接收委派

委派创建会话时的 `unattended-full-access` 映射到 Kimi ACP 原生 `mode=yolo`，并核对 `set_config_option` 返回的 `currentValue`。原生未确认时关闭 Transport 并返回错误；显式指定其他权限模式时拒绝创建。普通会话未指定权限模式时保留原生默认值。CLI 启动参数与 ACP 模式 ID 分别遵守各自接口，不互相替代。

## Kimi 计划审批

Kimi Code ACP 的 `ExitPlanMode` 请求包含原生 `plan_approve` / `plan_opt_N`、`plan_revise` 和 `plan_reject_and_exit` 选项时，Adapter 使用公共 Question 交互投影到 Codex 原生选择界面。计划正文、选项顺序和标签保留，选中结果原样回传 ACP `optionId`；修改计划、拒绝并退出和取消保持各自语义，不合并成同一个拒绝动作。

识别依赖工具名和完整的计划选项格式。其他工具审批、未知选项、重复标签或不完整格式仍走既有审批路径；普通会话权限、其他提问和公共审批投影不受此映射影响。

## Kimi Thinking 配置

Kimi 通过 ACP `configOptions` 提供当前会话、当前 Model 的 Thinking 列表和选中值。插件在创建、恢复、配置命令响应及 `config_option_update` 通知中读取这些事实，将列表保存在会话内存状态的 `availableThinkingOptions` 中，沿公共状态事件更新 Desktop；不轮询，也不在启动检查时遍历切换 Model。不同会话或 Host 不共享可变列表。

启动检查读取配置文件中的 Model 目录并检查认证，不创建会话。草稿目录按每个 Model 明确声明的 `capabilities`、`support_efforts` 和 `default_effort` 展示 Thinking：`thinking` 提供声明的强度列表，无强度列表时提供 `off/on`；`always_thinking` 排除 `off`；未声明思考能力的 Model 不提供选项。默认值仅在当前默认 Model 的选项内有效，显式 `[thinking]` 设置优先于 `default_effort`，不将其他 Model 的档位作为默认值。配置声明不代表后端实际支持，插件不自动补写用户配置。

会话建立后使用 ACP 原生列表和确认值，不以草稿默认值冒充已生效配置；未显式选择时保留原生默认配置。切换 Model 以返回的新配置整体替换旧列表，不自动重放旧 Thinking；原生未提供列表时清除旧列表。当前 Model 的选项不扩散到其他 Model。

显式选择或持久化恢复的 Thinking 值不在当前原生列表中时返回错误，不将 `medium` 映射为 `on`，也不静默替换用户选择。应重新选择原生支持的值或清除旧选择。`off/on` 是部分 Model 的原生取值，不是所有 Kimi Model 的固定能力。

## Cursor 剩余边界

Cursor 当前 ACP 没有 Usage、Fork、回滚或上下文压缩出口。macOS/Linux 的 Fork 通过隔离的 CLI 会话副本执行原生 `/fork`，历史位置再用 `/rewind` 的“仅恢复对话”选项回退，最后由 ACP 恢复；修订上一条复用这条路径，包括单轮回退为空会话。会话内容不做格式转换，目标边界必须有原生回退点。Windows Fork/修订和跨工作区 Fork 仍不支持。插件不重写原生消息来合成回滚，也不把普通 `/compact` Prompt 计为压缩。

Agent 间任务协作目前是单向的：正常 Cursor Session 可以在原生 shell 中通过 `codexhost-delegation` skill 调用 Host CLI，向其他 Harness 委派、查询及跟进任务。无人值守入站需要确认原生 Full Access 已生效，但 Cursor 的 `--force` 可能被团队策略静默降级，而 ACP 只公布 Agent/Plan/Ask，不能确认最终审批策略，因此仍返回 `unsupported`。这不同于缺少向外委派能力，能力表分别标明。

## Pi subagent 插件

Pi Adapter 接入 `pi-subagents`（nicobailon）的异步 Host 状态与检查协议，以及同步 workflow 的 `workflowChildren` 摘要，复用公共子 Thread 和渲染链路。异步转写是原生有界窗口；同步 workflow 从父结果定位只读子 Session，文件不可用时可展示明确标注的原生结果摘要。没有已支持身份协议的同步单 Agent 调用及其他同名插件不自动兼容。详见 [Pi subagent 映射](pi/pi-subagents.md)。

## Pi Codex Fast

Pi 当前 Model 同时具备 Codex OAuth、Codex API 和本地 `priority` 元数据时，Composer 显示默认关闭的闪电开关。Host 自动加载随插件交付的小型 Pi 扩展，通过原生 Provider 参数设置 priority，不依赖 Provider 名称，也不改变 Thinking 或 Pi 全局配置。缺少能力事实时不显示；真实服务端速度和额度效果未作承诺。详见 [Pi Codex Fast](pi/pi-fast.md)。

## Pi 权限模式

已核对本机 Pi `0.85.1` 的 RPC、get_state 和类型定义，没有原生会话权限模式目录或权限切换入口；其默认工具执行方式不等同于一个可选择的 Permission Mode。`--tools` / `--exclude-tools` 是工具装载过滤，`--approve` 是项目文件信任，均不能冒充统一的只读/询问/完全访问权限策略。

当前插件继续支持原生扩展交互，但不添加一套 Host 自行实现的 Pi 权限引擎。要支持可切换权限模式，需要 Pi 自身或明确安装的原生扩展公布策略、设置入口与生效确认；不能根据另一个 Harness 的权限名称推断 Pi 的行为。

依据：[Pi 官方 README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) 的 Philosophy 与 Extensions，以及本机 `pi --help` / RPC 文档。官方核心不提供 permission popups，允许通过扩展自定义确认流程；permission-gate / plan-mode 扩展示例分别采用命令匹配和工具过滤，不是核心权限模式。

## Antigravity ACP 审批、派生与压缩

Antigravity 通过官方 `agy acp`（要求 `agy >= 1.5.8`，已用本机 `1.5.9` 实测）接入：

- **权限与交互**：原生提供 `default`、`accept-edits`、`auto`、`plan` 四种 ACP 模式（`session/set_mode`）及进程启动级 `dangerously-skip-permissions`；工具审批走原生 `session/request_permission`，`ask_question` 走原生客户端 `elicitation/create`（`form` 模式），不使用私有 Hook 桥。详见 [Antigravity 权限与交互](antigravity/antigravity-tool-approval.md)。
- **历史读取**：只读 `~/.gemini/antigravity-cli/conversations/<id>.db` 的 `steps`，不启动 `agy`，不走 `session/load`（ACP 回放在 stdout 受阻时会提前回复并跨轮乱序，不可作为完整来源）。活动库读取已提交的 WAL 快照并跳过仍在生成的步骤；数据库不可读或格式未知时返回“历史不可用”，不降级。连续用户输入沿用既有分组规则合并，保证已存 Turn 身份稳定。
- **历史派生（Fork / Rollback）**：`agy acp` 1.5.9 未提供 `session/fork` RPC（返回 `-32601 Method not found`）。Adapter 在会话空闲态克隆 `~/.gemini/antigravity-cli/conversations/<id>.db`，按原生 `steps` 表 `step_type = 14`（`user_input`）边界裁剪并同步 `conversation_summaries.db` 后，经 `session/resume` 打开派生会话；活动 Turn 期间返回 `sessionBusy`。
- **压缩与实时命令**：命令目录保留内置 `antigravity.compact`（`/compact`）并通过 ACP `available_commands_update` 合并原生实时命令。在 ACP 模式下，`/compact` 作为原生斜杠命令随 `session/prompt` 发送给 `agy acp` 执行，但 ACP 流不推送旧 PrintMode 专有的 `checkpoint` 步骤事件，因此不合成独立的 `contextCompaction` Item。

## Copilot 原生接入

Copilot 使用官方 SDK 连接实际安装的 headless CLI，保留目标 Host 的原生认证和配置。本机验证为 SDK 1.0.25 / CLI 1.0.102 / macOS arm64 / gh-cli；目录为空时仍保留原生 auto，不编造 Model 或 Thinking 选项。原生会话、历史派生和公共接收委派已有实测，Desktop 及剩余自主/后台矩阵尚未完成。详见 [Copilot 接入与验证边界](copilot/copilot-harness-integration.md)。
