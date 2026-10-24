# Copilot 原生 Harness

`copilot` 插件通过官方 `@github/copilot-sdk` 的 headless stdio 接口连接目标 Host 安装的独立 Copilot CLI。实现、状态投影和 SDK 依赖位于 `packages/adapters/copilot`；Host/Renderer 使用公共插件目录和 Thread 契约，没有 Copilot 专用分支。当前验收基线为 SDK 1.0.25、CLI 1.0.102、macOS arm64。

## 安装与认证

安装独立 CLI：`npm install -g @github/copilot`。插件不会自动下载 SDK 配对 runtime；显式路径通过 `CODEXHOST_COPILOT_COMMAND` 指定，指定路径失效时不会寻找另一份安装。版本检查读取实际 CLI，仅已识别的 npm 全局安装可使用原 prefix 更新；其他渠道使用原包管理器。

SDK 使用 `mode: copilot-cli` 和 `useLoggedInUser: true`，保留目标用户的 HOME、COPILOT_HOME、原生配置和凭据库。插件不读取、导出、复制或保存 Token。VS Code 扩展和独立 CLI 的登录来源不能混为一谈：本机实测原生报告 `gh-cli`，没有额外 `/login` 也能执行请求；这证明 GitHub CLI 登录复用，不证明 VS Code 凭据共享。只有 CLI 确实缺少认证时才需要在原生 CLI 中登录。

工厂环境与每次 open 的 environment 合并，Session 覆盖优先，undefined 删除变量。create、resume、Fork 和 Rollback 都使用目标 Host 的环境；本机认证不复制到 SSH。

Windows 的标准 npm `.cmd`/`.bat` 启动器通过同目录 `node_modules/@github/copilot/package.json` 的身份、bin 与启动器引用共同确认，解析到同一安装的实际 `.js` 或可执行入口。SDK 用 Node 参数列表启动 JavaScript，不执行包装脚本、不调用 shell，也不回退到其他安装。未知包装器或不完整安装返回明确错误；Windows 布局与含空格路径已通过 fixture 检查，Windows 实机仍未验收。

## 检查与诊断

同一 Adapter 的环境固定，同一规范化 cwd 的进行中 inspect 共用一次 Client 检查；不同 cwd 独立。当前 availability 与完整检查执行相同路径，因此也共享结果。成功结果在 Adapter 生命周期内复用，与 Pi、OpenCode 等插件一致，普通会话切换不因时间流逝重新启动 CLI 查询模型。refresh 跳过已完成缓存，但会加入同作用域已在进行的检查；原生登录或模型配置在外部变化后，通过显式刷新重新检查。缓存表示最近成功的检查结果，实际执行仍由原生校验当前认证和模型资格。失败和清理失败不缓存，进行中记录在完成后移除；close 清除缓存、停止临时 Client 并等待检查清理，不允许关闭后的结果写回缓存。

错误保留公共类型、友好提示和操作阶段，诊断使用公共脱敏工具并限制长度。超时、权限拒绝、认证、模型配置、连接中断和损坏历史有不同原因；不复制 SDK stderr、stack 或 RPC 数据。交互错误不携带答案，损坏日志诊断只保留错误类别、行列位置和原生错误码，不输出损坏行正文。

## 会话和配置

创建和恢复会话均设置 `enableConfigDiscovery: true`，由原生 CLI 按自身发现规则加载全局及项目的 skills、custom agents 和其他受支持配置；保留原生禁用规则，不额外复制 Codex 或 VS Code 的配置。

普通草稿惰性初始化；首次配置命令会建立本实例独占的原生空会话，以 setter 和读回确认选择。未提交用户消息的草稿关闭时，原生 disconnect 后删除该空会话。不能以 Session 列表不可见推断没有磁盘残留。用户消息一旦形成原生历史，正常 close 保留历史。

Model/Thinking/权限只公布可用且经原生确认的状态。Adapter 的目录为 Desktop 提供明确的初始选择：优先 Auto；没有 Auto 时按原生目录顺序选第一个可用模型；空目录不伪造选项。用户已有的选择由公共 Renderer 的偏好机制优先保留。这个初始选择通过普通 Model 参数提交，Session 再做资格校验和原生读回；它不是已生效状态，也不改写用户的 CLI 默认配置。直接调用 open 而省略 Model 时仍保留原生默认语义。目录读取使用原生 RPC，显式选择刷新会话目录，不依赖 SDK listModels() 的首次结果缓存。

Auto 是 Copilot 的原生路由选择，不是某个具体模型，也不是 Thinking 档位。CLI 1.0.102 的 headless 目录可能省略该虚拟条目；插件在原生 GitHub 认证有效或会话公布 Copilot provider 时提供 Auto，其他 provider 不据此获得 Auto。当前 CLI 的 `/model` 明示 Free 账号仅支持 Auto，这与[官方套餐说明](https://github.com/github/docs/blob/main/content/copilot/get-started/plans.md)一致；不能把 Auto 实际调用的 gpt-6-luna 当作账号可以手动选择的模型。

Thinking 使用 `session.model.setReasoningEffort`，只接受当前模型公布的选项并读回确认。Auto 原生拒绝 reasoning effort，不提供 Thinking 选项；低层 setter 可写入字段不证明其受支持，未公布支持的值不显示为有效 Thinking。manual 和 allow-all 已实测；assisted 在本机被原生拒绝，保持原状态。

无人值守使用原生 allow-all 权限、显式关闭会话 sandbox、保留原生提问/表单回调的配置。启动前确认权限与托管 sandbox 状态；创建时政策冲突失败，不统一批准回调或自动回答。原生任务若需要澄清，沿公共 Interaction 显示，用户通过原 Thread 处理。执行意图保存在 Native Ref 的非敏感 locator 中，冷恢复沿用；创建时与该意图冲突的显式权限被拒绝；创建后用户可实时切换权限，冷恢复尊重原生当前权限。

## Turn、历史与派生

一次用户输入包含整个原生 Agent Loop。内部 `assistant.turn_end` 和 `assistant.idle` 都不是用户 Turn 终态；等待 `session.idle`，取消还需 aborted 确认。turn.start 在原生根 user.message 的逻辑身份确认后才报告接受，避免立即取消时将未落盘请求误归到上一轮。

`turn.steer` 明确返回 `unsupported`，不提交输入或取消原生执行；公共 Host 按停止当前 Turn 后新开一轮的流程处理。不将 SDK 的隐式排队或隐藏消息注入当作已验证的同 Turn 插入能力。

取消 RPC 的成功、失败和超时处理绑定发起时的执行实例；原生已确认旧轮终结后，迟到响应不得取消新轮交互或将新轮置为故障。交互清理按所属 Turn 执行，重复清理不重复发送关闭事件。

Native Session Ref 的 formatVersion 为 1，locator 为 `{storage:"copilot-cli",version:1}`；无人值守另含 `executionPolicy:"unattended-full-access"`。使用目标用户的原生存储，不能把 Ref 移到另一用户或另一原生配置目录冒充恢复。Native Turn key 是持久根 messageId；Item 身份使用原生 messageId、reasoningId 和 toolCallId。

恢复保留身份、占用和工作目录检查，直接调用 SDK resume 并显式设置 `allowTranscriptRecovery: false`。不存在或损坏的会话失败，不创建空替代会话，不授权原生修补日志；若运行时仍返回恢复修补标记，也拒绝接受。初始化不再丢弃一次完整分页读取的结果；完整历史在 readSnapshot 时读取，Fork 仍使用完整分页与全文前缀保真校验。

只读历史不重新发布 outputs。缺少持久的结束证据时 Turn outcome 为 unknown；不能因为有最终文本就推断成功。无根消息的新请求产生的 abort 不得修改上一轮结果。持久分页 cursor 失效会有界重读，仍失败则拒绝部分快照。

Fork 的 Checkpoint 是逻辑消息身份，执行时从新鲜历史求出下一根用户事件作为排他边界。Rollback 通过新身份保留最后一轮之前的前缀，包括单轮到空前缀。派生校验可见历史前缀，并保留当前配置；不重发可见消息、不修改源会话、不执行文件回滚。跨目录 Fork 不支持。

## 输出与用量

文本、公开 Reasoning、工具、同步命令和压缩沿公共 Items 输出。异步 shell 的调用结果表示启动后台工作，按工具调用显示，不冒充命令已经退出。没有可靠 diff 时保留原生工具结果，不根据路径构造文件 Diff。审批提供单次允许/拒绝；legacy ask_user 提供单选或自由文本；primitive elicitation 表单保留布尔、数字和多选并验证约束。回答只作用于唯一交互；legacy ask_user 没有独立取消响应，取消该问题使用原生 abort 结束当前 Turn；结构化表单使用原生 cancel 动作。浏览器 URL elicitation 当前明确返回 unsupported。

后台任务变更使资源租约保持占用，直到原生 task list 确认状态；压缩进行中同样阻止释放和不完整历史读取。未知状态不会当作空闲。当前支持可关联到稳定根消息的自主输出和后台存活追踪；Autopilot/Plan 模式明确拒绝。完整原生 Subagent Transcript 属于 P2。

工具的 start、输出、进度和 complete 使用同一 toolCallId 归属。已退休工具的迟到事件不进入新的实时 Turn；没有匹配工具起始记录的 completion 不生成文件 Diff。只读历史按起始记录关联原所属 Turn，后到的有效后台结果仍保留在该轮；即使工具实际完成，父轮的取消或失败状态也不被提升为成功。实时终态之后不追加 Item，后续历史快照可以反映原生日志新补齐的工具事实。

会话用量来自 `usage.getMetrics` 的累计 token 快照及 `session.usage_info` 的上下文占用。快照替换而非重复累加。可靠的 totalNanoAiu 按原生单位除以 1e9 显示为会话 AI Credits；累计值替换，不重复相加。partial/unavailable 或没有金额时不显示完整花费；未声明完整性的旧版本仅接受正的原生累计值，不把零默认值当作免费证明。premium request cost 不当成 AI Credits，也不换算美元。请求级计量和全局统计属于 P2。

## 验证范围

真实 CLI 已覆盖多轮、预热配置与清理、取消与续跑、冷恢复、同目录精确 Fork、Rollback 到空前缀，以及无人值守工具环境传播。公共 Host Coordinator 的接收、busy、read/wait、取消、提问的人接管协议、活动期权限切换、回滚换绑及 Host 重建后续跑已通过真实 CLI 集成测试。测试使用临时 Host 映射和合成官方 Codex 对端；这不替代真实 Desktop UI 验收。

完整边界、未完成矩阵和证据见 [39 行能力清单](../../../packages/adapters/copilot/CAPABILITIES.md)及[原生验证记录](../../../packages/adapters/copilot/test/NATIVE-VERIFICATION.md)。Desktop 的 Picker 和 Auto 菜单已在真实窗口验证；初始预选 Auto 后直接发送已通过浏览器到真实 CLI 的受控验收；完整工具/交互/恢复 UI，以及 SSH、Linux、Windows 尚未验收。P2 包括跨目录 Fork、原生 Subagent Transcript、请求级计量、向下委派、一键安装、历史导入和全局统计。


## 速度与缓存命中率

原生 assistant.usage 与根 assistant.message 按 apiCallId 关联，只有归属于当前逻辑 Turn 的请求才更新速度；重复、子 Agent 和迟到的其他 Turn 数据不会混入。生成速度使用本轮总输出 Token / 各请求的总 (duration - outputTtftMs)，排除首字等待及本地工具等待；API 平均速度使用总输出 / 总 duration，包含首字等待。原生 outputTokens 已包含推理，不重复相加。每次可靠模型请求完成后更新；缺少计时不做字符数估算，同一连接保留最近有效测量。实时事件不持久，冷恢复后需要新请求才能重新显示速度。

最近缓存命中率使用原生请求 cacheReadTokens/inputTokens；该事件的 inputTokens 已包含缓存。累计快照的 input 字段则是未缓存输入，需加 cache_read/cache_write 后通过 sessionCacheUsage 提供给公共 Host 计算平均命中率。累计缓存事实可冷恢复，最近请求命中率不能靠历史总数伪造。现有用量浮窗和摘要栏自动显示这些公共字段，不修改 Host 或 Renderer。

## 账号额度

设置页通过 inspectAccount 查询当前原生认证的账号预算，浮窗通过 credits()/refreshCredits() 读取最多 15 秒缓存。只展示原生 authoritative_budget 的百分比和明确单位的已用/限额；AI Credits、requests、tokens 保持各自单位，未知单位只提供可靠百分比。无限额度、advisory balance 和不可用数据不伪造成零；周期未知时不猜测月度，重置时间仅在原生提供时显示。

额度 API quota.refresh 需要会话上下文。查询使用独占临时草稿，关闭配置/skills/hooks 发现，不发送模型输入、不修改用户配置，读完立即 disconnect/delete/stop。显式刷新清除旧缓存并重新解析认证，查询前后身份不同则丢弃结果；关闭等待清理，失败草稿可重试删除。该临时查询策略不改变正常对话启用原生配置发现的行为。

金额来源和单位见[官方 SDK 用量说明](https://github.com/github/copilot-sdk/blob/v1.0.25/docs/features/usage-and-billing.md)与生成 RPC 的 TokenPriceUnit。账号额度可能受服务端汇总延迟影响；它不是某个历史 Thread 实际计费账号的绑定。
