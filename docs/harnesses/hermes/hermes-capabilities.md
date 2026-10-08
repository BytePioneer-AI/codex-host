# Hermes 原生能力与接入边界

实现只位于 `packages/adapters/hermes/`；公共 Adapter、Host Runtime、Renderer 不包含 Hermes 专用逻辑。

## 原生传输与兼容性

会话统一使用 Hermes 的正式 `tui_gateway` JSON-RPC stdio，不要求特定 Hermes 发布版本。不比较发布版本或 desktop backend contract 的数值；启动验证实际的 `gateway.capabilities.per_session_exclusive_submit` 能力，新版 managed runtime 通过所选 launcher 的 `--print-runtime-command --module` 获取原生命令，保留 Python、源码路径和 bootstrap，不重建或剥离原生启动代码。Gateway 探测、正式启动（含委派）、模型解析、历史读取与 Fork/恢复共用该运行方式；旧版不提供该接口时保留 shim/venv 发现与 `-I` 隔离，存在原生 bootstrap 时先激活它。显式 `CODEXHOST_HERMES_GATEWAY_PYTHON` 优先且不回退其他解释器。探测不到可用 Gateway 或启动失败时明确报告，不再保留 ACP 聊天后备、热进程或模型／权限选择分支。历史发现和导入改用同一原生运行环境下的 `SessionDB(read_only=True).list_sessions_rich`；Gateway `session.list` 缺少 cwd 和最近活动时间，不能单独满足导入契约。查询不创建或加载聊天 Session，不改写数据库或配置；不再保留任何 ACP Transport 或 SDK 依赖。原生根身份、压缩后的当前元数据与配置控制的列表过滤保持一致，不把 continuation 当新会话重复导入；无固定 200／1,000 条总数截断。缺少有效 cwd 或时间的记录跳过，跨进程运行状态未知时返回 null。导入提交重新查询选中身份，关闭 Adapter 取消读进程。导入返回的不带 locator 的 Hermes 原生 SessionDB 引用，通过真实 Gateway `session.resume` 恢复并校验持久化身份和工作目录后才返回 Gateway locator；不预先重标引用，不复制或改写 Transcript。带其他 transport locator 的引用及未恢复的非 Gateway 派生源明确拒绝。旧 gateway locator 中的 `contract` 字段被忽略，新引用不再写入该字段。聊天事件、审批、命令与配置使用 Adapter 内部契约。每个 gateway Session 使用独立进程，Adapter 拒绝为同一会话重复创建 owner。

Gateway 区分 runtime ID 与持久化 ID。Host 保存持久化根 ID；恢复时核对原生当前物理 ID，压缩生成 continuation 后仍由 Hermes 官方 lineage 解析读取，保持先前 Turn 身份。工作目录使用真实路径比较；Fork 不支持跨工作目录。Model、Provider、Thinking 使用原生配置及实际确认值；选择不会修改全局配置。YOLO 是原生进程内权限状态，因此确认后的选择保存在 Hermes 自有 Native Ref locator，支持关闭源会话后的派生和恢复。`default` 表示关闭会话 YOLO 并遵循原生全局审批策略；全局策略仍导致 YOLO 时，不能把关闭会话开关误报为恢复审批。权限目录只有原生策略和会话 YOLO，不保留 `accept_edits`。

## 提问、工具、Thinking 与 Usage

Gateway 的 `clarify` 映射为 Host Question，支持单题、批量题、文本、单选和多选，保留原生选项与自填语义。Host 验证答案后回复原生请求；多选通过原生支持的 JSON 数组编码，选项中的逗号不会被拆开。`request.cancel` 的超时映射为 expired，取消/关闭后不回复迟到答案。审批保留原生 once、session、always、deny，分别映射单次、会话、永久和拒绝。

模型目录探测优先调用所选 Hermes launcher 的 `--print-runtime-command`，由原生 bootstrap 选择安装绑定的 Python 与依赖 generation，不假定新版存在 `venv/bin/python`。不提供该接口的旧版仍使用原有 shim/virtualenv 发现。原生运行命令一旦确认，执行失败或输出异常直接报告，不回退到另一份安装。探测复用 Hermes 原生 `_has_any_provider_configured` 检查；明确返回未配置 Provider/API Key 时返回 `configurationRequired`，Desktop/Web 显示「需要配置」，提示运行 `hermes setup` 后重新检测。旧版没有此检查时不凭空目录推断未配置，也不把解释器或网络故障误报为配置问题。明确未配置会清除此前的目录缓存，避免后续超时继续掩盖状态。

模型目录探测在同一 Adapter 内合并并发读取，避免重复启动 Python。刷新超过 20 秒时，仅在已有成功读取的原生目录时继续使用该目录；后续成功刷新替换缓存。首次读取超时、解释器故障、返回格式错误仍报告失败。缓存仅在当前 Adapter 生命周期内有效，不写入用户配置。

模型目录的正式路由与当前默认模型均通过 Hermes 原生 Provider resolver 解析；显示名、配置键和历史 aliases 不混作路由，不从 aliases 挑首个 `custom:`。裸模型名保留大小写、冒号和斜杠；`custom` 直连端点不替换为首个命名 Provider。旧 API 缺少解析 helper 时保留目录原始路由。相同路由去重，不合并不同 Provider 的同名模型；原生明确不可用的模型不供选择。已配置默认模型在非空可用目录中缺失或匹配多个路由时明确报错，不自动选择首项。历史 aliases 仅用于默认引用匹配，不重写已有 Native Session 引用；会话状态的历史别名恢复兼容不在目录解析范围内。

Thinking 目录直接对应 `hermes_constants.parse_reasoning_effort` 的 none/minimal/low/medium/high/xhigh/max/ultra。选择调用 `config.set(scope=session)` 并回读确认；none 确实关闭 reasoning，而非原生仅用于显示的 hide。实际模型是否接受相应 effort 仍遵循 Hermes 原生模型实现。

工具状态与完整结果来自 `tool.start` / `tool.complete.result`，不把截断的 summary/result_text 当完整结果。专属进程通过原生 `HERMES_TUI_TOOL_PROGRESS=all` 开关启用工具生命周期，不改用户配置。reasoning/text 流式和最终内容去重；成功 `message.complete` 的最终正文与尚未完成投影的回答一致时，显式标记 `final_answer`，避免末尾补发 reasoning 后实时界面缺少回答动作、只有重读历史才出现。失败或中断的部分正文不标为最终回答。取消等待原生终态；无法确认独占提交或压缩 pending 时终止会话，避免不确定的原生任务与下一轮重叠。状态变更 RPC 超时、底层协议故障及关闭均释放自有进程组，Windows 使用 taskkill 树终止；只读 Usage 与命令目录查询的超时不关闭正常聊天连接。

Usage 接入原生 `session.usage` RPC，并接收 Turn 内及闲置时的同名事件。Session 打开、Model 确认切换、Turn 结束、自动压缩阶段结束及 Host 主动刷新时读取；合并并发轮询，忽略晚于新推送或关闭的旧响应，Model／Turn 边界在已有轮询结束后补读，避免沿用切换前的上下文。只投影原生可靠数值：累计 input/output/reasoning/total、context_used/context_max，以及可选 context_percent/cache_hit_pct。缺失或非法字段不补零；不反推精确缓存 Token，不解析账号额度文本，不把 Nous Credits 换算为通用 Provider 费用。可选刷新失败不制造聊天失败。

## Edit Diff

Gateway 的原生 `inline_diff` 只在工具完成后投影 `fileChange`，通过 `sourceItemIds` 关联工具。失败、拒绝或取消不会把预览当已应用修改。gateway 的 inline_diff 是带 ANSI、文件箭头标题、行数上限的显示片段，按明确 hunk 状态解析；正文中的箭头和 `---`/`+++` 不成为假文件名。

保守标记 `diffScope: fragment`、`kind: update`：Gateway 的原生显示可能截断，不能当整文件补丁。每工具最多 32 个片段、1 MiB。持久化工具结果未保存渲染时的旧文件快照，历史恢复保留完整工具输入/输出，但不重建未知 Edit Diff。

## 斜杠与压缩

Gateway 保留 `/help`、`/tools`、`/context`、`/version`（原生 `slash.exec`）和 `/compress [focus]`（原生 `session.compress`）。已加载 Session 的动态目录同时读取 `complete.slash` 与 `commands.catalog`：补全列表可能截断，不能当全量目录；原生 catalog 补足条目、来源和参数元数据。只追加已审核的只读内置命令与原生注册的插件命令，遵守公共排除名单和 Hermes 控制命令／别名排除项，不暴露原生 Terminal、配置或消息平台专属入口。`kind: skill`、技能元数据及快捷命令别名不作为 `slash.exec` 命令执行；技能／bundle 的 pending-input 和 origin 合同尚未接入此目录。

目录与执行都使用当前 Session／工作目录，执行前重新读取并验证命令和参数，拒绝已撤销、不安全及非终态返回的命令。参数原样交给原生 `slash.exec`，不实现 Host 命令引擎；插件处理器仍是用户安装的原生代码，来源检查不承诺插件任意副作用为只读。发现期间同样守住单 Turn 排他性，关闭或失败后不启动迟到任务。命令输出不进入聊天 Transcript，也不生成虚构 NativeTurnRef。新草稿与尚未加载的 Session 按公共命令路由使用静态目录／工作目录缓存，不为列菜单启动进程。

压缩生成 `contextCompaction` Item。Gateway 依据结构化状态：实际 compressed 成功，无变化/锁未获得为带原生原因的 no-op，summary generation aborted 为 Item 和 Turn 失败；pending 不是成功，关闭进程释放未完成工作。不再解析 ACP 的人类可读压缩文本；缺少 Gateway 结构化结果明确失败，不猜测成功。不会把无变化或原生总结失败描述成用户取消。自动压缩观察活动 Turn 的 `status.update(kind=compacting)` 与 `kind=compacted`。重复心跳不产生新阶段；原生 warning 原样展示但不作为提交结论。`compacted` 在锁竞争、提交围栏中止或可行性失败等路径也可能发出，不能据此宣称压缩成功。

因此自动阶段以 `commentary` 状态消息展示开始、原生提示与阶段结束，明确说明提交结果未知，不生成暗示成功的 `contextCompaction` Item，也不依据文本、Token 下降或聊天成功推断压缩成功。Turn 结束、失败、取消或关闭时收尾未确认的观察消息，保留原生 Turn 结果；这些消息不是最终回答，不写入原生历史。当前 Gateway 没有可靠的自动压缩提交成功／失败／取消结果接口；闲置阶段不合成 Host Turn，尚无完整自动压缩生命周期或标准 Summarizing 控件对齐。

`/model` 使用专门的确认配置接口；`/reset`、原地 undo/rewind，以及 slash 形式的 queue/steer 不作为命令暴露，避免破坏 Host 历史或绕过排他 Turn。Gateway 的同轮插入使用 `session.steer`，见下文。

## 精确 Fork 与修订上一条

Gateway 原生 `session.branch(count)` 只复制显示文本并丢弃工具关系，因此没有用于实现公共历史契约。插件通过官方 `SessionDB` 只读完整消息/工具行，以真实 row ID 和原生 display_identity 建立稳定 Turn 身份；使用 `user_originated_turn_view` 与 `_history_to_messages` 排除内部续跑、压缩摘要、hidden 行，保留用户原始技能命令显示。

未压缩且可完整验证的历史产生包含前缀长度与完整消息摘要的 checkpoint。Fork 使用官方事务性 export/import 复制精确前缀；修订上一条导出源会话并只保留最后一个真实用户 Turn 之前的完整原生消息。新会话使用新 ID、父关联及保留的 model_config/profile；复制后逐字段校验工具输入/输出，并确认源消息未变。源会话正在运行时拒绝派生。若后续启动失败，只删除本实例刚派生、父关联与内容摘要均未变的新会话，绝不删除源。

压缩归档或 continuation 的历史仍可恢复查看，但原生 import 会重新激活消息，不能无损复制当前模型上下文。因此此类 Session 不产生 checkpoint，派生明确返回 unsupported；过期 checkpoint 返回 checkpointNotFound，不做近似复制。

## 跨 Harness 协作发现

Gateway 保留 `CODEXHOST_CLI_PATH`、`CODEXHOST_RUNTIME_ENDPOINT`、`CODEXHOST_RUNTIME_TOKEN`、`CODEXHOST_THREAD_ID`。仅 writable Session 且四者齐全时，在 OS 临时目录创建私有 Skill 文件，通过 Hermes 原生插件 API `PluginContext.register_skill` 仅在当前 gateway 进程注册 `codexhost-runtime:delegation`，追加到已有 `HERMES_TUI_SKILLS` 列表。说明沿原生 ephemeral system prompt 路径加载，新会话和已有历史的恢复会话均可用。内容只指导按 CLI --help 发现已授权的 delegate/thread 命令，不包含变量值或凭据。不安装插件、不修改用户配置、不向 active home/skills 写入临时技能；其他 Hermes 进程没有此项注册，不会发现它。正常关闭和启动失败清理私有临时目录；强杀整个 Host 至多残留 OS 临时文件，不会污染 Hermes 技能列表。inspection、gateway probe、history reader 不创建或注册技能。

原生 Hermes delegate_task 仍可用，不将原生子代理与跨 Harness 委派混称。

## 原生依据与验证范围

实现与原生验证依据为 NousResearch/hermes-agent `1450c7fcfb5cca740e9b76545bd2ecdec94f4aa0`（0.21.3）；该发布版本是测试记录，不是安装或恢复门槛：

- [正式程序化协议与 owner 约束](https://github.com/NousResearch/hermes-agent/blob/1450c7fcfb5cca740e9b76545bd2ecdec94f4aa0/website/docs/developer-guide/programmatic-integration.md)
- [Gateway Session 创建、恢复、压缩](https://github.com/NousResearch/hermes-agent/blob/1450c7fcfb5cca740e9b76545bd2ecdec94f4aa0/tui_gateway/methods_session.py)、[实际配置设置](https://github.com/NousResearch/hermes-agent/blob/1450c7fcfb5cca740e9b76545bd2ecdec94f4aa0/tui_gateway/methods_config_set.py)
- [工具生命周期及原生 diff](https://github.com/NousResearch/hermes-agent/blob/1450c7fcfb5cca740e9b76545bd2ecdec94f4aa0/tui_gateway/tool_progress.py)、[diff 显示片段](https://github.com/NousResearch/hermes-agent/blob/1450c7fcfb5cca740e9b76545bd2ecdec94f4aa0/agent/display.py)
- [持久化数据库](https://github.com/NousResearch/hermes-agent/blob/1450c7fcfb5cca740e9b76545bd2ecdec94f4aa0/hermes_state.py)、[导入导出](https://github.com/NousResearch/hermes-agent/blob/1450c7fcfb5cca740e9b76545bd2ecdec94f4aa0/hermes_state_portability.py)
- [原生会话列表与压缩 lineage 投影](https://github.com/NousResearch/hermes-agent/blob/1450c7fcfb5cca740e9b76545bd2ecdec94f4aa0/hermes_state_sessions.py)

协议 fixture 测试覆盖 Question/审批/配置确认、diff 片段、命令与压缩失败/取消、迟到事件、重复回答、进程故障、Gateway-only 路由及 owner，并覆盖 Usage 并发／旧响应、目录截断／来源过滤／撤销、自动压缩心跳／未知提交结果及只读 RPC 非致命超时。可选原生测试用 `CODEXHOST_HERMES_NATIVE_TEST_PYTHON` 指向已安装的上述 Hermes Python；在隔离 HERMES_HOME 下真实执行 SessionDB 派生/回滚/压缩 lineage，运行本地 OpenAI 模拟服务驱动真实 gateway/clarify/terminal 与恢复，并验证进程内技能预加载、用户已有技能保留、原先没有委派说明的会话恢复，以及 Host CLI 环境。测试不调用付费模型；尚未进行真实外部模型压缩或 Desktop 端到端验收。另有 `CODEXHOST_HERMES_NATIVE_TEST_LAUNCHER` 选入的 managed-runtime 测试，验证正式启动器下的模型解析、真实 SessionDB 历史、精确 Fork、源历史不变、委派 preload、Gateway 懒恢复，以及导入样式的无 locator 引用通过真实 Gateway 恢复；使用原生 home root 下的临时独立 home 共享已安装依赖，不修改用户配置或历史，不发模型请求。自定义原生安装根可通过 `CODEXHOST_HERMES_NATIVE_TEST_HOME_ROOT` 指定。

版本兼容回归在真实 Hermes 子进程中仅替换发布版本和 contract 元数据，验证创建、工具交互、历史读取、Fork 与恢复；不修改安装文件。原生发现测试覆盖超过 1,000 条候选、旧原生存储的 cwd 元数据、压缩根身份去重、无 locator 引用和数据库／配置不变；定向测试覆盖删除及元数据复查、关闭取消、超时、坏响应和错误隔离。Gateway 引用无论旧、新或缺少 contract 元数据都可恢复。实际接口缺失、响应格式错误、会话身份不一致或历史校验失败仍会报错；这些检查不依赖版本号。元数据替换测试不代表已经验证其他发布版本的全部接口行为。

## 同轮插入

Gateway 主路径声明 `capabilities.steer`。`turn.steer` 调用 `session.steer`，参数是 `{session_id, text}`。`queued` 表示原生接受；`rejected` 是 `invalidState`，不计入本轮插队数。没有版本号门槛。

空文本是 `invalidRequest`。目标不是当前活跃 Turn、会话已关闭，或插入期间 Turn 已经结束，是 `invalidState`。Adapter 不取消、不另起 Turn，也不发布 `userMessage`。忙时 `turn.start` 仍是 `sessionBusy`。

现有历史投影把每一条带 `user_text` 的用户行当成一轮，包括插入行。Adapter 不按 `display_kind` 把插入并回原提问。本轮结束时，锚点之后新出现的 Native Turn 数等于 1 加本轮已被原生接受的插队数，才把第一条（原提问）当作本轮身份。数量不符，或开始时的锚点已经不在历史里，仍然失败。零插队且没有新行时，保持原先可以没有 NativeTurnRef 的成功结果。

未实机验证。本机没有 Hermes。行为依据 gateway `session.steer` 的 `queued` / `rejected` 回执，以及现有用户行分轮。单元测试覆盖 gateway 声明、RPC 参数、非活跃目标、身份计数、数量不符、忙时 `turn.start`，以及不发布 `userMessage`。
