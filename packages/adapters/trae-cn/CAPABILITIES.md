# TRAE CN Desktop 能力清单

## 基本信息

| 项 | 内容 |
|---|---|
| Harness ID | trae-cn |
| 原生接口与传输方式 | TRAE CN 桌面扩展桥接 `electron.ahaIpc`，调用应用自带 `harness.dll` / `ai-agent` JSON-RPC；复用应用登录 |
| 已验证的原生版本 | Windows x64：TRAE CN 3.4.12 原生执行；3.4.13 预装插件经隔离 Host 实际对话及冷恢复续聊；VS Code core 1.107.1 |
| 交付范围 | 仓库内插件 + 桌面 Companion 扩展；原生接口为应用私有接口，须独立验收版本兼容性 |
| 参考插件 | WorkBuddy 的应用发现与应用拥有的认证；公共 Harness 输出和交互契约 |
| 最后验证 | 2026-10-31～11-02 Windows；真实对话、文件编辑与 Diff、活动恢复、提问及审批、文本 Fork / Rollback、单轮文件编辑回退为空；3.4.13 只读兼容和更新后的自动检查 |

## 能力

在实现 TRAE CN 插件前建立。原生探测成功不等于下表已实现；未验收的能力保持「待验证」。不使用独立 Trae CLI 的登录、模型或 Session。

| # | 功能 | 必做 | 优先级 | 结论 | 实现位置 | 证据 | 备注 |
|---|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | 支持 | manifest.json | schema 与真实 Loader 目录描述符校验 | 开发状态、桌面依赖及中英安装说明 |
| A2 | 工厂 | 必做 | P0 | 支持 | src/plugin.ts | 真实 Loader 两个独立实例、搬移 Bundle、独立 Node 进程导入 | 冷构造；复制环境；关闭隔离；应用路径优先级 |
| A3 | 检查 | 必做 | P0 | 支持 | src/adapter.ts | test/adapter.test.ts；真实 inspect | 不创建会话，不启动桌面窗口；同作用域目录缓存 |
| A4 | 创建 Session | 必做 | P0 | 支持 | src/session.ts；assets/companion/service.cjs | 公共 Session 首轮真实创建及文件读取 | 延迟至首轮；原生 Project 绑定目录 |
| A5 | 执行 Turn | 必做 | P0 | 受限 | src/session.ts；src/live-items.ts | 公共普通对话、文件工具、提问、命令审批及持久历史一致 | Builder、Read、Edit、RunCommand 和提问已验收；其他工具语义待补 |
| A6 | 取消 | 必做 | P0 | 支持 | src/session.ts；assets/companion/service.cjs | 公共提问等待中 turn.cancel 后，公共与持久原生均 cancelled，同 Session 随后成功续聊 | Interaction 关闭一次；过期回复拒绝；不将请求回执当终态 |
| A7 | 只读快照 | 必做 | P0 | 支持 | src/history.ts；src/session.ts | 重复读取真实历史的 Turn / Item 身份一致；恢复缓存 unknown 快照；原生历史提交延迟实测 | 普通活动读取返回 sessionBusy；终态确认短暂重读同一身份 |
| A8 | 持久身份 + resume | 必做 | P0 | 受限 | src/adapter.ts；src/session.ts；src/history.ts | 跨进程普通恢复、活动提问 / 审批恢复；后台命令完成后，重建 Companion 与两个新 Host 的三轮完整冷读一致 | 后台仍运行时冷恢复明确返回 sessionBusy；不丢弃命令、不重发原任务；缺映射及不确定状态拒绝 |
| A9 | 错误与并发 | 必做 | P0 | 受限 | src/session.ts；assets/companion/service.cjs | native / service / session 测试；真实跨进程活动恢复 | 本机准入串行；不确定回执无自动重试；仅恢复原身份，其他工具故障待补 |
| A10 | 关闭 | 必做 | P0 | 支持 | src/session.ts；assets/companion/native.cjs | 公共关闭测试；真实观察者断开后原生 completed | 不把关闭观察者当作 native cancel |
| B1 | 切换 Model | 原生有则必做 | P1 | 支持 | src/configuration.ts；src/session.ts；assets/companion/models.cjs | 公共 model.select；原生 Assistant 确认 Seed-Code → Seed-2.1-Turbo → Seed-2.1-Turbo → Seed-Code；活动时切换、冷恢复、模型存储哈希不变 | 下次请求生效；按桌面原生逐轮 DTO 配置；不修改全局偏好；旧 Companion 不声明支持；不把历史 Turn 改标为新模型 |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 支持 | src/models.ts；configuration.ts；session.ts；assets/companion/reasoning.cjs；models.cjs | MiniMax-M3.1-Flash 两次真实请求的持久配置为 light / high，回复匹配；活动切换、跨进程恢复、文本 Fork / Rollback、桌面偏好哈希不变 | 使用模型原生档位及字段；无隐式默认；选项按模型隔离；接受的 Turn 固定配置；旧 Companion 不声明支持 |
| B3 | 权限模式 | 原生有则必做 | P1 | 受限 | assets/companion/permissions.cjs；src/permissions.ts；configuration.ts；session.ts | 当前原生菜单四项与默认读取；manual_approval / full_access 各一次实际 RunCommand 完成并生成正确文件；活动切换与冷恢复；全局配置哈希未变 | 本地国内版；按动态 / 用户开关过滤 Auto / Custom；请求顶层和 client_info 同时传原生字段；原生历史未存档位，恢复 Host 确认提示，不推测旧权限；无人值守仍拒绝 |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 支持 | src/adapter.ts | test/adapter.test.ts：unattended-full-access 在连接前返回 unsupported | 通过明确拒绝满足契约；不忽略执行意图或伪造审批 |
| B5 | Fork | 原生有则必做 | P1 | 受限 | src/derivation.ts；assets/companion/history.cjs | 原生文本 Fork、精确前缀与源隔离；后台命令前缀的写入前拒绝回归 | 保留文件编辑或后台执行身份的前缀不能复制；不复用源 Session 的命令 ID |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 不支持 | src/derivation.ts | 目标 cwd 不同在原生写入前返回 unsupported | 未证明原生跨 Project 复制；不以改变进程目录冒充支持 |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | 受限 | src/derivation.ts；src/session.ts | 文本多轮 / 单轮及单轮文件编辑回退的原生证据；后台前缀拒绝与单轮回退为空的回归 | 独立 Session；保留非空文件编辑或后台命令前缀时拒绝；不回滚工作区或取消源命令 |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | 受限 | src/background.ts；commands.ts；history.ts；live-items.ts；assets/companion/commands.cjs、diffs.cjs | Read / Edit / RunCommand；3.4.13 真实 Host 中后台命令先 detached，父轮及后续聊天完成后按原退出码与输出结算；进行中历史叠加及桥接 / Host 冷恢复一致 | 仅 RunCommand；按原 Session / 消息 / Plan / command ID 查询；16,384 字符窗口，实时溢出明确故障；后台中冷恢复暂缓；无独立命令停止控件，其他工具待补 |
| B9 | 审批 | 原生有则必做 | P0 | 受限 | src/interactions.ts；src/approvals.ts；assets/companion/interactions.cjs | RunCommand、Edit 与 DeleteFile 允许 / 拒绝原生验收；实际文件作用、原历史及新进程冷恢复一致，全局权限未变；MCP 与资源读取确认有原生界面源码与测试 | 文件允许使用事件拥有的 toolcall_id，命令 / MCP 使用 tool_name；仅允许一次 / 拒绝；旧 Companion 缺能力标记时明确提示升级；MCP 实时审批仍待验收；不支持持久授权 |
| B10 | 提问 | 原生有则必做 | P0 | 支持 | src/interactions.ts；assets/companion/interactions.cjs；settings.cjs | 公共问题只发布一次；显式答复“停止”，持久完成回复 TRAE_CN_PUBLIC_QUESTION_OK_STOP | 复用桌面开关；实例校验；不使用预填答案；单选、多选、其他及跳过映射测试 |
| B11 | 原生 Subagent | 原生有则必做 | P2 | 待验证 | — | — | |
| B12 | 自主 Turn | 原生有则必做 | P1 | 受限 | src/session.ts；src/background.ts | 3.4.13 原生 command 状态从 running 到 completed；toolcall/poll_pending_wakeups 实际返回 unknown route；后台结果未生成新用户消息 | autonomousTurns.observe=false；普通 Builder 当前后端无可用唤醒路由；不发送隐藏普通消息模拟自主续轮；Ralph / Goal 不在接入范围 |
| B13 | 会话用量 | 原生有则必做 | P1 | 受限 | src/usage.ts；src/session.ts；assets/companion/service.cjs | 原生历史数值白名单；同 Session / 新进程恢复的 initialUsage 一致；只读刷新仅调用 snapshot；实时映射测试 | 仅上下文占用 / 窗口；原生历史只保留末次请求，累计字段为占位 0，故不显示会话累计 tokens、费用或估算价格 |
| B14 | 请求级计量 | 原生有则必做 | P2 | 待验证 | — | — | |
| B15 | 接收委派 | 必做（验证项） | P1 | 受限 | src/adapter.ts | 3.4.13 真实 Host Coordinator.start 经已加载插件返回 DELEGATION_FAILED，未改变父会话历史；普通 Thread 跨进程可续聊 | 当前委派固定使用 unattended-full-access，插件明确拒绝；不能作为可接收无人值守任务的 Harness |
| B16 | 向下委派 | 原生有则必做 | P2 | 待验证 | — | — | |
| C1 | 展示元数据 | 必做 | P1 | 支持 | manifest.json | schema、Loader 描述符、名称与向量图标 | 当前 CodexHost UI 验收另列；没有专用 Renderer 分支 |
| C2 | 手动安装指引 | 必做 | P1 | 支持 | manifest.json；scripts/build-companion.mjs；assets/companion/README.md | VSIX 实际安装并激活；独立 ZIP 检验完整资源与许可证 | 应用与扩展分别安装；不使用 Agent CLI 登录 |
| C3 | 版本检查与更新 | 必做 | P1 | 支持 | src/installation.ts；src/plugin.ts | 读取实际 appVersion=3.4.12；17 项版本 / 发现 / 工厂 / 搬移测试；自动更新明确拒绝 | 手动更新；application 口径；最新版本 Unknown；原生桌面或官方安装器更新；不混用 VS Code core 版本，不更新其他安装，不重启活动会话 |
| C4 | 首次安装 | 可选 | P2 | 不适用 | — | 桌面应用由官方安装器分发 | |
| C5 | 自定义启动路径 | 条件必做 | P1 | 支持 | src/plugin.ts；src/discovery.ts | 工厂路径优先级、发现中的正确 / 错误安装过滤测试 | 只限定连接的应用，桌面需自行打开目标目录 |
| C6 | 会话导入 | 可选 | P2 | 待验证 | — | — | |
| C7 | 全局用量统计 | 可选 | P2 | 待验证 | — | — | |
| C8 | 账号额度 | 可选 | P2 | 待验证 | — | — | |
| D1 | Workspace / 构建 | 预装时必做 | P1 | 支持 | package.json；scripts/build-plugin.mjs；scripts/build-companion.mjs | 根 build:typescript 生成预装插件；搬移 Host / 插件独立运行；payload / npm 文件集验证 | Companion 为单独安装的前提，不自动安装或随 Host 激活；本机一项 payload 符号链接用例受 Windows EPERM 限制 |
| D2 | 预装清单 | 预装时必做 | P1 | 支持 | scripts/release/harness-plugins.json | 相邻插件根的启用列表、真实 Loader 和搬移发行 Host 目录均含 trae-cn | 不增加 Host / Renderer 静态注册 |
| D3 | 加载测试 | 预装时必做 | P1 | 支持 | installed-harness-plugins.test.ts；tests/release/host-bundle.test.mjs；trae-cn-plugin.test.mjs；trae-cn-companion.test.mjs | 完整预装集合、仓库外 Host / Bundle、缺 Companion 的可重试 configurationRequired、独立实例和 VSIX 检验 | 3.4.13 预装插件经隔离 Host 完成两轮真实对话，第二轮由新进程恢复后复述原答复；不代表用户日常窗口已加载 |
| D4 | 文档 | 预装时必做 | P1 | 支持 | docs/harnesses/trae-cn/trae-cn-desktop-integration.md；README 与中韩入口；capability-boundaries.md；assets/companion/README.md | 构建、预装 / 独立安装、API 版本、Companion 前提及实验性边界一致 | 完整 Desktop、审批和自主 / 后台能力的未验收状态仍保留 |
| D5 | 其他 | 可选 | P2 | 不适用 | — | — | |

## 受限与已知缺口

后台命令：Companion 0.1.9 用原消息拥有的 plan ID、llm tool-call ID 与 command ID 调用 check_toolhost_command_status，校验 Session / Project / 命令 / cwd，并白名单转出结果。已通过原生 running → completed、输出和退出码验证；不是以工具启动成功推定执行成功。公共 Item 通过 item.detached 继续存活，父轮和后续前台轮均可先完成，再由只读轮询终结原 Item；hasBackgroundWork 阻止空闲释放。只跟踪当前观察作用域已准入的命令，关闭或故障结束观察，不隐式取消原生进程。后台仍运行时冷恢复返回 sessionBusy，完成后可正常恢复；保留后台执行身份的历史派生在写入前拒绝。Native 输出窗口为 16,384 字符，实时窗口溢出明确故障，冷历史保留截断标志。普通 Builder 的后台唤醒路由在 3.4.13 实际返回 unknown route，故自主 Turn 保持关闭，不发送普通 Prompt 冒充原生唤醒。

活动恢复的公共契约缺口与实现：原生实测可在断开观察者后重放同一问题实例，并继续同一用户消息；旧 Host 只在 turn.completed 持久化 NativeTurnRef，knownTurnRefs 没有原 Host Turn ID。API 2 新增可选 activeTurnRecovery、turn.identity.confirmed、knownTurns 和 recoveringTurn，Host 提前持久化原身份并按确认映射恢复原投影；Broker 转发，Renderer 沿用原公共投影，没有 TRAE 专用分支。旧 API 1 插件仍可加载且不接收新输入；TRAE 插件声明 API 2，拒绝在旧 Host 上执行。没有确认映射时不会猜测或重发任务。

当前处于开发阶段，尚无可交付的完整 TRAE CN Harness。插件 Manifest / 工厂、Bundle、Companion VSIX、本机 HTTP、公共 Adapter、普通 Session、结构化提问、命令 / 文件 / MCP 单次审批映射、已确认身份的活动恢复、逐轮模型 / Thinking / 本地权限选择及受限的历史派生已实现；预装发行接线与搬移验证已通过；审批覆盖、其余能力及当前用户 Desktop 验收尚未完成。独立 Node 进程不能直接使用 Electron 内置 IPC。登录令牌只在应用进程内用于原生调用，不导出、不持久化。客户端分离观察者不会发送原生 rpc.stream.cancel，因为该通知实测会取消生成；Companion 保持原生连接和确认状态的更新直至结束。

历史派生限制：3.4.12 的原生 fork_session 可以精确复制文本会话前缀，但不会为复制的文件编辑用户消息建立对应的快照 Git 标签。一次独立原生探测创建了可读消息但不可读文件快照的副本；源历史不变，副本已停止并保留供核查，没有重试或删除用户历史。插件在写入前拒绝含文件编辑的 Fork，以及需保留非空前缀的文件编辑 Rollback。只有一轮时，Rollback 创建独立空会话，无需复制快照。会话回退不回滚工作区文件。新会话身份、精确前缀和源历史均重新核对；不确定回执不自动重试，已知副本验证失败时报告其原生 ID。

原生模型管理接口 `model_list` 与会话菜单接口 `model_list_by_function` 的范围不同。模型管理接口不作为对话目录来源；目录按原生 Agent function 读取，并过滤 `status === false` 或 `selectable === false` 的模型。自定义 Provider 的失败不等于桌面登录失败；已观察到原生服务返回 Provider HTTP 401，不能用桌面登录状态代替模型调用验收。

模型切换语义：桌面的 getModelRequestSelection / buildSendMessageRequest 为每次发送构造 custom_model DTO，并非让原生流中的活动请求换模型。Companion 0.1.4 的 prepareModel 刷新原生目录、校验原生 Session 作用域并准备同一 DTO，仅返回无凭据的标识确认；公共 model.select 更新后续请求配置并发布状态。已接受的 Turn 固定原模型和配置修订号，旧 metadata / model_config 不覆盖新的后续选择。Host 保存的选择在 resume 时重新准备，不改历史模型。桌面的 localThread.writeSelection 只支持官方模型，并在当前 Builder 目录实测返回 MODEL_UNAVAILABLE，故不依赖该前端存储命令，也不改用户全局选择。

Thinking 选择：Companion 0.1.6 区分普通模型的 reasoning_effort_config、内部账号的旧 reasoning_effort_options，以及自定义模型的参数声明。只有通过原生校验的档位进入 Bridge，账号仅转出内部策略布尔值，不导出登录信息。真实普通账号 Builder 目录目前仅 MiniMax-M3.1-Flash 返回 light / high / extra_high，其他模型没有有效声明时不补造档位。公开选项按 Agent、模型、原生字段和档位隔离；prepareModel 精确确认后才发布状态，已接受 Turn 固定配置。冷恢复重新准备未来选择，保留历史原生配置；换模型整体替换列表并清除不适用档位，不指定隐式默认。没有 Thinking 档位时，实时与冷恢复都保留明确的空列表。

权限选择：Companion 0.1.7 只读动态配置、用户开关和最多 1 MiB 的本地 permission/global.json，沿用原生 Auto 可见性、Custom 存在性及默认规则，不导出授权资源或命令规则。preparePermission 验证原生作用域和档位后，公共选择配置下一轮；发送时同时设置消息顶层及 client_info 的 permission_profile_id。活动 Turn 固定原选择，不改全局配置。原生历史及 Session 元数据均未提供档位，只有 Host 已保存提示可以恢复，不以消息内容补造。远程和企业权限菜单不声明支持；未知活动 Profile 报错。手动模式也可能按原生规则直接执行允许的命令，不承诺每条命令都会弹审批。

审批覆盖：Companion 0.1.8 明确声明文件 / MCP 审批能力，旧 Companion 不提供不可执行的按钮。文件操作的允许决策沿用原生 toolcall_id，拒绝使用 tool_name；删除沿用其无新增权限范围的专用格式。MCP / ReadMcpResource 沿用工具名，仅按原生新权限开关和请求元数据使用 execution / none，旧权限系统省略该字段。不提供 task / device 授权，不修改规则。界面保留目标文件、资源和 MCP 参数；未知格式或超限参数明确拒绝。文件修改和删除的允许及拒绝均已做真实验收；MCP 目前只有源码依据及回归测试。

MCP 原生前提（2026-11-03）：已在独立项目准备无网络、无命令执行的本地 Echo MCP，协议自测通过；用户在原生安全确认后开启了项目级 MCP。TRAE CN 桌面日志确认该项目的测试服务及工具已加载，Native 也生成了工具目录。然而实际 Builder 首轮返回工具不可用，未调用 MCP、未产生审批；随后只读 agent/get_agents 确认当前内置 builder_v3 的 mcp_list 为空，原任务为 Finished。尚需核实原生 Agent 绑定 / 调用路径，不以服务已加载、工具目录可见或模型回复代替 MCP 执行与审批验收；原任务保留且未重发。

删除快照：Companion 0.1.10 对终态 DeleteFile / delete_file 读取原用户消息快照，不依赖原生未提供的 can_show_diff。仅将 deleted.after_content=null 和 added.before_content=null 解释为不存在的一侧，其他缺失正文仍拒绝。真实工作区内删除的完整 before_content 已恢复成 fileChange，并通过新进程精确冷读；原工具与回复未变，没有重发删除。工作区外专用文件通过原生单次允许后确实删除、拒绝后保持原内容；该外部文件的原生快照返回空列表，因此只保留实际工具结果，不从当前文件系统补造历史 Diff。旧 Companion 缺少删除快照时明确要求升级。

Edit 参数清空：原生执行结束会清空 old_string / new_string。工具 Item 的固定参数排除这两个原生可变字段，实际改动仍来自消息快照 Diff；路径与其他稳定参数继续校验。真实允许后曾触发参数不变保护，已用规范化原生序列复现并修复；新一轮不同内容的修改完成后，四轮历史与冷快照一致。旧成功轮、拒绝轮和取消轮均保留，没有重发原任务。

会话用量限制：已核对 3.4.12 的原生 token_usage 事件与持久历史；prompt_tokens / completion_tokens / total_tokens 是最后一次模型请求，prompt_tokens_total / completion_tokens_total 在实测中均为占位 0。当前只把 last_turn_total_tokens 和 max_tokens 映射成上下文占用及窗口，不把单次请求或格式化 input/output 字符串当作会话累计消耗。刷新失败不使普通 Turn 失败，活动时刷新不覆盖实时用量。

## 插件外改动

预装清单、完整集合加载测试和搬移 Host 发行测试已加入 trae-cn。公共 API 2 扩展涉及 shared-contracts、harness-adapter、Host Runtime、Broker 及对应测试和文档；缺省兼容 API 1，无 Harness 专用公共分支。`package-lock.json` 注册 Workspace、三个公共契约依赖以及 Companion 打包 / ZIP 验证开发工具；根 `tsconfig.json` 加入该包的构建引用；`eslint.config.js` 为应用内 CommonJS 资源加入通用检查；`docs/index.md` 添加开发说明入口；`tests/release` 新增插件搬移和 VSIX 资源验证。开发工具不进入运行时 Bundle。先前独立 CLI 原型已从最终变更中撤回。

## 验证记录

后台观察（2026-11-03）：最终完整 Adapter / VSIX / 插件 / 搬移 Host 族 236 项通过；typecheck、lint / boundaries 与改动格式通过。覆盖拒绝启动、执行身份变化、终态输出仍在刷新、后续轮并行、观察关闭及后台中冷恢复。真实 3.4.13 + 开发 Companion 0.1.9：在原专用 Thread 中完成后台新轮与后续纯文本轮，父轮 / 后续轮先结束，原命令随后输出 TRAE_CN_HOST_BACKGROUND_NEXT_DONE、exitCode=0；历史进行中叠加正确。Companion 进程退出后重建，两个新 Host 精确读取同一三轮历史，原前缀和三条唯一映射不变，Native Finished。先前脚本分别误选 thinking 兼容 Item、误读完成帧中的省略输出，保留失败记录后按真实增量和历史核对；没有重发旧命令。安装包包含十二个 CJS 资源。

删除补验（2026-11-03）：TRAE CN 3.4.13 / 开发 Companion 0.1.10。原工作区删除在只读快照中确认完整旧内容和 null 新内容，经公共 Adapter 及新 Node 进程恢复出相同删除 Diff。另用两个工作区外专用文件分别验收 DeleteFile 单次允许 / 拒绝，文件系统结果与决定一致，Interaction 各关闭一次，全局权限哈希不变；新进程原样恢复两条历史。外部文件无原生 Diff 的限制单列；没有重发原删除。Adapter / 插件 / VSIX / 搬移 Host 族 241 项、根构建、typecheck 和改动文件 ESLint 通过。上一 Head ed6719b7 的四平台 CI 全部通过；删除修复 Head 的 CI 需另行检查。

0.17.0 基线（2026-11-03）：91c9cd95 的四平台 CI 全部通过，run 41487098357。补丁分支随后合入上游 b3094d5a（0.17.0），保留上游新增 Harness 与功能，不用旧 Host 覆盖日常运行时。根 build:typescript、build:renderer、typecheck、lint / boundaries 通过；Adapter / 插件 / VSIX / 搬移 Host 与完整预装组合 264 项通过、1 项跳过；API 2 恢复、Runtime、Loader、Broker 和恢复 Schema 聚焦集 142 项通过、4 项跳过（含本机无法建立的符号链接用例）。没有合并为累计测试数；合入后的新 Head 需单独 CI。当前用户窗口仍未替换或重启。

0.17.1 基线：后续合入上游 cf2c6d0c（0.17.1），解决其无原生身份历史保留与 API 2 活动恢复的同处冲突。只读刷新先保留尚无原生身份的本地失败 / 取消历史，再排除由活动 Projector 持有的 Turn，避免刷新后重新加入其旧失败副本。新增刷新期间仍保留原活动身份与 inProgress 状态的回归；上游历史元数据用例、恢复用例与 Adapter / 插件 / VSIX / 搬移 Host 族共 267 项通过。根构建、Renderer 构建、typecheck、冲突文件 ESLint / 格式和 boundaries 通过。新 Head 的 CI 独立检查；本机已更新至 TRAE CN 3.4.14，先前原生执行证据仍只按其实际 3.4.12 / 3.4.13 版本标注。

后台结果保护检查：11 项源码对应的后台 / 前台边界用例；修复前其中 9 项失败，补充一项 running 数据状态后全通过。完整 Adapter、独立插件 / VSIX 与搬移 Host 发行检查共 208 项通过；typecheck、lint / boundaries 及改动代码格式通过。没有执行原生后台任务，故不作为后台控制或自主 Turn 的真实验收。

公共配置持久化修复：Host 的模型切换路径现按拥有该 Session 的完整确认状态更新或清除 Thinking 提示，避免恢复时复活旧模型档位。这是既有契约的通用修复，没有 TRAE 专用分支。两个故障用例已先复现，再通过修复；模型 / Thinking 投影、Fork 与预热共 66 项回归以及 typecheck、lint / boundaries 通过。

| 层次 | 命令或方式 | 结果 |
|---|---|---|
| Adapter 公共行为 | test/adapter.test.ts、test/session.test.ts、test/history.test.ts、test/live-items.test.ts | 普通创建、取消、关闭、历史与空闲恢复已覆盖；其他能力仍待实现 |
| 原生边界 | 独立 Extension Development Host 中加载仓库 native.cjs | 应用登录、模型目录、创建、发送、事件和原生历史读取均已实测 |
| Companion 传输 | 从独立 Node 客户端调用开发扩展的本机 HTTP | 续聊、真实文件工具、观察者断开、主动取消与取消后续聊均核对持久历史 |
| 公共原生验收 | HarnessSession 两轮，随后新进程 Adapter.open(resume) 第三轮 | 文件工具、实时输出、持久 NativeTurnRef、源历史前缀和续聊均已实测 |
| 公共提问 | Native AskUserQuestion → 公共 Interaction → interaction.respond → 原生结果与持久历史 | 显式“停止”答复，关闭一次，公共与原生 Turn 均成功；活动历史不充当确认状态来源 |
| 公共取消 | Question 等待时 turn.cancel，核对持久 NativeTurnRef；同 Session 再发一轮 | cancelled 一致，问题关闭一次且旧回复拒绝；续聊回复 TRAE_CN_PUBLIC_CANCEL_RECOVERY_OK |
| 公共命令审批 | 工作目录外专用验收文件的 RunCommand，分别允许一次和拒绝 | 允许后文件存在、exitCode=0；拒绝后文件不存在、保留原生沙箱 failed / exitCode=1；全局权限未改变 |
| 公共文件编辑与 Diff | 同一专用 Session 两轮 Read / Edit；snapshot.get_message_ai_edit_file_diff_list；新进程只读恢复 | 原生文件内容和 Diff 一致，公共 fileChange 完成一次，实时与持久身份一致；恢复后两轮 patch 不变，回复 TRAE_CN_PUBLIC_FILE_EDIT_OK |
| 上下文用量 | 同一专用 Session 的原生历史；公共 initialUsage / refreshUsage；新进程只读恢复 | 上下文数值与原生一致，跨进程不变；仅有 snapshot 读取，没有 create/start；未声称总 tokens 或费用完整 |
| 文本历史派生 | 原生整会话复制；公共中间与末尾 Fork、多轮 / 单轮 Rollback；新 Node 进程只读验证 | 精确复制 1 / 6 / 5 / 0 轮，源历史不变；中间 Fork 续聊复述原文，空白 Rollback 回复 TRAE_CN_ROLLBACK_EMPTY_OK；原生实时上下文用量已确认 |
| 文件编辑历史限制 | 两轮文件编辑源的写入前拒绝；另建专用单轮文件编辑源，再回退为空 | 多轮源没有 fork/create/start；单轮源仅创建一个空白 Session，回复 TRAE_CN_FILE_EMPTY_ROLLBACK_OK；模型、源历史及实际文件不变；两个 Session 冷恢复一致 |
| 模型切换 | 公共选择、冷进程恢复后发送、活动请求中选择、原生 Assistant 的 config_name / model_name、新进程最终读取 | 四次成功回复的实际模型为 Seed-Code / Seed-2.1-Turbo / Seed-2.1-Turbo / Seed-Code；原生配置名与解析模型名均匹配；所检查的桌面模型选择存储哈希不变 |
| 模型验收异常核对 | 验收脚本重复创建输出消费者，第四轮取消；只读原生核对后另发一条新验收消息 | 原取消轮原样保留，没有重发；第五轮回复 TRAE_CN_MODEL_RECOVERY_OK；新进程读取五轮历史完全一致；原生状态 Finished，无活动遗留 |
| Thinking 选择 | 公共 thinking.select；Light 运行中选择 High；新 Node 进程恢复后发送；第三个进程只读核对 | 原生 Assistant 持久字段 reasoning_effort_level 分别为 light / high；答复 TRAE_CN_THINKING_LIGHT_OK / TRAE_CN_THINKING_HIGH_OK；原历史不变；每进程只有一次 start；桌面偏好哈希不变 |
| Thinking 与历史派生 | 两轮 Light / High 源的中间 Fork 和 Rollback；新进程恢复 | 两个副本都只有 Light 历史且当前选择为 High，源不变，没有额外 start/create；冷读取完全一致 |
| Thinking 选择回归 | Adapter 全套 158 项；补充两项派生用例后的 46 项受影响回归；两个发行打包测试；typecheck、lint / boundaries、改动代码格式 | 均通过；VSIX 0.1.6 的十个 CJS 资源与源码字节一致；不同测试集合重叠，不累加计数 |
| 权限选择与冷恢复 | manual 请求执行期间选择 full；下一条新消息在新进程中恢复 full；两次 RunCommand 实际写入；只读终态和历史核对 | 原生 Finished，准确两轮，回复 TRAE_CN_PERMISSION_MANUAL_OK / TRAE_CN_PERMISSION_FULL_OK；每轮只发送一次，源前缀和全局权限哈希不变；没有以“无审批”推断权限失效 |
| 权限验收异常与修复 | 初次脚本错误要求手动模式必有审批；保留完成记录并只读核对后，另发 full 新任务；冷读取暴露空 Thinking 字段不一致 | 没有重发原命令；先新增失败回归再修复；修复后原两轮的完整冷快照与实时快照哈希一致，未新增任务 |
| 权限回归与资源 | 37 项配置 / Adapter / 打包检查；14 项历史派生；18 项服务测试；typecheck、lint / boundaries、代码格式；本地化后 11 项 Adapter 检查及插件构建 | 均通过；集合重叠不累加。VSIX 0.1.7 含十一个 CJS 资源。最终源码重载后，四个原生权限选项逐项准备确认，没有发送新任务，已有两轮历史未变 |
| Thinking 与通用持久化 CI | d768124c：GitHub Actions 41291130813 | Ubuntu、Windows、Linux ARM64、macOS 15 全部通过；后续权限改动需新 Head 的 CI |
| 文件审批与参数清空回归 | 原生 Edit 允许及拒绝；规范化真实序列先失败再修复；新任务与冷进程核对 | 允许后内容准确修改，拒绝文件未变；保留四轮原历史及取消轮；新答复 TRAE_CN_FILE_EDIT_VERIFIED_OK；全局权限哈希不变；没有重发旧请求 |
| 扩展审批自动检查 | 185 项 Adapter / 打包检查；能力协商及旧权限范围调整后的 71 项定向回归；typecheck、lint / boundaries、代码格式 | 均通过；测试集合重叠不累计。Companion 0.1.8 仍为十一个 CJS 资源；MCP / 删除确认使用源码对应格式，尚无实时审批证明 |
| 权限选择 CI | fd104cd8：GitHub Actions 41293220947 | Ubuntu、Windows、Linux ARM64、macOS 15 全部通过；后续审批改动需新 Head 的 CI |
| 应用升级只读兼容 | 2026-11-02：TRAE CN 3.4.13 + 最终开发 Companion 0.1.8，新 PID / 实例与源码哈希核对 | 9 个模型、4 个权限、新审批能力标记；原四轮 Finished 会话冷状态哈希一致；仅 snapshot / preparePermission，没有创建会话或发送消息；不代表 3.4.13 实际推理及审批已验收 |
| 插件加载 | 真实 Loader 加载仓库外 Bundle；独立 Node 进程导入 | 身份、资源、独立实例与关闭隔离均通过；无 Workspace 运行依赖 |
| Companion 安装包 | 官方 vsce 打包；独立 ZIP 读取；TRAE CN 本地安装 | 身份与许可证完整，7 个 CJS 文件字节一致；实际安装版本 0.1.0 |
| 已安装插件链路 | 已安装 Companion 的进程、扩展目录和 SHA-256；仓库外插件完成原生 Turn | 同一持久身份读到 TRAE_CN_INSTALLED_PLUGIN_OK；未作为当前 CodexHost / Renderer 验收 |
| Host 集成 | 隔离 AppServerHost + 真实 Loader / Mapping Store，提问与审批等待时关闭，再由新 Node 进程 resume | 终态之前已持久化身份；原 Turn 恢复；唯一历史与映射；thread/read 读到真实回复，官方路径未启动；未作为用户当前 Desktop 验收 |
| API 2 回归检查 | typecheck；lint / boundaries；185 项聚焦测试；142 项受影响 Agent / 打包测试；5 项 Loader / Broker 定向检查 | 均通过；测试集合存在重叠，不累加计数。Loader 全文件另有 3 项文件符号链接用例因本机 Windows EPERM 未通过；macOS 原生接口未验证 |
| 文件快照回归检查 | typecheck；lint / boundaries；Adapter 全套与两个发行测试共 115 项 | 全部通过；Companion 0.1.1 资源清单、八个 CJS 字节及搬移 Bundle 均已核验；真实文件编辑使用开发窗口，未升级普通窗口的 Companion |
| 上下文用量回归检查 | typecheck；lint / boundaries；119 项 Adapter 测试及两个发行测试；真实只读跨进程验收 | 均通过；不累计重叠测试数量。Companion 0.1.2 安装包已验证，普通窗口尚未升级 |
| 跨平台 CI | ad21e0d9：GitHub Actions 41268028791 | Ubuntu、Windows、Linux ARM64、macOS 14 四项通过；该结果属于历史派生之前的基线，不代表 macOS 原生桌面接口已验证 |
| 历史派生回归检查 | typecheck（含测试类型）；lint / boundaries；Adapter 全套与两个发行测试共 136 项 | 全部通过；Companion 0.1.3 的九个 CJS 文件、许可证与搬移插件均已验证；新增原生操作在独立开发窗口验收，用户当前 Host / Desktop 未升级 |
| 应用版本检查 | 公共插件工厂 installation(check)，显式选择实际 TRAE CN 安装目录 | 只读 appVersion=3.4.12；latestVersion=Unknown，application 口径；installation(update) 返回 unsupported；没有模型请求、安装或桌面重启 |
| 历史与应用版本 CI | d033ae09：GitHub Actions 41270667398 | Ubuntu、Windows、Linux ARM64、macOS 15 全部通过；模型切换改动之后仍需新 Head 的 CI |
| 模型选择回归检查 | typecheck；lint / boundaries；149 项 Adapter / 打包测试；补充恢复后配置用例后的 16 项 Session 定向回归 | 全部通过；测试集合重叠不累加。覆盖空会话手动选择、活动模型固定、失败回执、冷恢复提示、配置与准入串行、关闭竞态；实际桌面与当前 Host 验收范围仍区分 |
| Thinking 能力读取 | TRAE CN 3.4.12 开发窗口，只读原生会话目录；规则、模型、设置、Service 与 VSIX 35 项聚焦测试 | 读取到 MiniMax-M3.1-Flash 的三档原生能力；未发送模型请求。新增 reasoning.cjs 已加入 VSIX 资源审计；不作为 Thinking 切换完成证据 |
| 模型选择 CI | d335ae18：GitHub Actions 41272342868 | Ubuntu、Windows、Linux ARM64、macOS 15 全部通过；后续 Thinking 读取改动需新 Head 的 CI |
| Thinking 读取回归检查 | typecheck（含测试类型）；Adapter 全套及两个发行测试共 155 项 | 全部通过；Companion 0.1.5 的十个 CJS 资源、许可证与插件搬移均已验证；原生能力读取不等于 Thinking 配置写入已实现 |
| 真实原生验收 | TRAE CN 3.4.12 Windows，复用桌面登录，Builder / Seed-Code | 原生 done.status=completed；重连历史 finish.summary=CODEXHOST_TRAE_CN_OK；不是 Host 端验收 |
| 预装发行与 3.4.13 执行 | 根 build:typescript；完整集合 Loader；搬移发行 Host；两进程真实会话 | 预装目录 / 启用 / 缺 Companion 诊断通过；3.4.13 两轮真实对话，冷恢复精确且上下文续聊成功；当前用户窗口仍未验收 |
| 发行检查 | 46 项 Host Bundle / npm 检查；8 项 payload 检查；完整集合 Loader、独立插件 / VSIX 和工厂检查；typecheck、lint / boundaries | 均通过；初次两项 npm stderr 断言受到环境 UNDICI-EHPA 警告影响，关闭该警告后通过；payload 一项符号链接验证因本机 EPERM 未通过，定向检查中排除并单独记录 |
| 扩展审批 CI | f298d2aa：GitHub Actions 41469773726 | Ubuntu、Windows、Linux ARM64、macOS 15 全部通过；预装接线之后需新 Head 的 CI |
| Desktop / 委派 | 当前日常 Runtime 0.17.0 仍为插件 API 1；真实 Coordinator.start 使用 unattended-full-access | 旧 Host 无法加载 API 2 插件；无人值守委派明确拒绝；普通 Thread 的两轮与冷恢复已验证，不能据此声称完整 Desktop / 委派支持 |
