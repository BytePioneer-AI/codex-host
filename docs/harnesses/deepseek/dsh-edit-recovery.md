# DSH 消息修订、恢复与原生停止确认

Adapter 只支持写 Session Format V4 的 DSH，最低版本为 `0.1.7-rc.1`；已在 `0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1` 和 `0.2.0-rc.2` 上验证，通过 codexhost 托管、认证的 Web Remote 创建、恢复和 Fork 原生 Session。更低版本在启动托管 Web 前以 `unsupported` 拒绝并提示升级；不低于门槛的其他规范 SemVer 版本按 V4 尝试，仍须通过原生协议校验。V0/V3 profile 与 Legacy 协议均已移除，证据与边界见[版本验证记录](dsh-version-validation.md)。

修订上一条消息使用原生历史操作，仅回滚最后一个回合；Fork 根据原生 seed 标记和已验证的历史前缀确认继承关系，不改写源会话。恢复通过公开历史 API 读取，保持 Native Session ID 和原生配置语义。

| 项目 | V4 行为 |
| --- | --- |
| 原生历史与流式 | V4 日志：`developer/message`、`startSeq`/`endSeq` surface 替换、`tool` 角色的工具结果、image offload、workspace changes；Assistant 以独立 baseline/start/chunk/end 帧流式输出，`assistant/message` 与 `assistant/attempt` 持久化结算 |
| Checkpoint | `v4-turn-end:<seq>`，locator 为创建它的精确 CLI 版本 |
| Fork 种子 | 原生前缀截至所选 `turn/end`，随后只有一条 `{ inherited: true }` 的 `session/end-seed`；切点位于回合结束处，不带 `forked` synthetic closer，之后也不能出现新的 `turn/start` |

DSH 在打开旧 Session 时自行迁移到 V4；codexhost 不迁移原生文件，也不保证新日志可以由旧版 DSH 打开。Session Ref 没有 locator（V0 时期）或带任意合法 SemVer locator（V3/V4 时期）时都可以尝试恢复，历史仍须通过 V4 校验。迁移可能重编号 seq，因此 Fork 只接受 `v4-turn-end:` 前缀且 locator 与当前 CLI 版本完全一致的 checkpoint；`turn-end:`、`v3-turn-end:` 或其他版本创建的 checkpoint 在修改原生会话前拒绝。回滚最后一个回合始终从当前原生历史重新计算 checkpoint，不受此限制。

原生 Fork 可能继承下一回合的待处理输入。Adapter 在接纳新子会话前，仅通过原生队列接口移除可证明来自继承前缀的待办，再读取确认，避免冷恢复重新执行已经回滚的输入；来源不明或无法确认时明确失败。

系统消息和开发者指令参与原生 surface 引用和替换，不作为用户回合展示。DSH 的限时提问回复以 `user-question-reply` 来源的 `user/message` 写入日志，同样不投影为用户输入。

## 工具调用恢复

DSH 会给没有结果的工具调用补写 `tool/result`：崩溃后恢复，以及其他客户端在回合中途创建的 Fork 种子（所有已验证版本都由 `openTurnClosers` 生成）；自 `0.2.0-rc.1` 起，失败的 step 也由 `ToolCallRecovery` 补写。已启动的调用得到 `ToolOutcomeUnknownError`/`TOOL_OUTCOME_UNKNOWN`，并以 `sourceEventSeqs` 指向其 `tool/call`；未启动的调用得到 `ToolNotStartedError`/`TOOL_NOT_STARTED`，不带 `sourceEventSeqs`，只有一个文本块，id 为 `forked-tool-result-<callId>-<seq>` 或 `interrupted-tool-result-<callId>-<整数>`。Adapter 只接受这些精确形状，其他缺少 `tool/call` 的结果仍按协议错误拒绝。实时事件和冷历史都把它们投影为失败的 Tool Item，Item 身份一致；若对应调用是 PTC 的 `run_code`，与下述规则一致不显示。不会伪造成功。

## 流式与 Tool 显示

文本增量在最终消息持久化前实时展示。若 DSH 放弃或重试一次生成，已经展示的部分输出标记为取消，新的尝试独立显示；最终消息修订了已流式输出的文本时，旧 Item 同样标记取消。重新读取历史时只保留 DSH 持久化的可见消息，不会将失败尝试的文本拼接进成功答案。

可见的原生思考增量也会实时展示。流式末尾换行先暂存，由最终消息确定权威文本；仅末尾换行数量不同不会取消临时思考 Item。Codex 思考预览与 `thinking` 卡片不显示末尾换行，正文段落换行保留，原生历史仍不改写。临时思考被最终消息修订、移除或被放弃时，旧 Item 明确标记取消；新的最终 Item 只显示原生权威内容。重连按原生 Assistant baseline 去重，冷恢复仅从 DSH 持久化历史读取最终思考。

带非空 `command` 参数的 `pwsh` Tool 使用可展开命令框显示完整命令和有界输出；缺少有效命令时仍按普通 Tool 显示。PTC 模式下模型调用 `run_code`，程序内实际执行的每个 Tool 只记录在子调用事件中。Adapter 在实时事件和冷历史中把每个 `tool/ptc-dispatch*` 子调用投影为独立的 Tool Item，Item 身份取自子调用开始事件，实时耗时取自两条原生事件的时间。外层 `run_code` 调用本身不显示：Desktop 普通 Tool 卡片只能显示工具名，无法展示程序源码和输出，而程序执行的 Tool 已逐一显示；程序未调用任何 Tool 或在调用前失败时，该步骤不出现卡片。因此子调用中的 `pwsh` 同样显示完整命令，`read`/`grep`/`glob` 沿用命令卡片，`todo_write` 更新计划，`edit`/`write` 按参数计入回合文件改动。子调用未写入开始事件时，以结束事件补出 Item；回合结束时仍未结束的子调用随回合结果完成。子调用结束事件可附带与 `tool/result` 相同的可选失败标识（`name`/`code`/`reason`）。

## 关闭与持久化确认

活动 Session 关闭先请求取消，再等待对应原生 `turn/end`。未关联请求不能被另一个自主 Turn 的终态遮蔽；故障先于关闭时，本地清理不能证明原生停止；关闭期间晚到的接受回执仍获得终态。无法确认停止时明确拒绝 close。

正常会话关闭和 Fork 队列清理后，还会通过认证的原生 `HEAD /api/session.export` 等待日志写入完成；该请求不下载日志内容。原生回执和内存历史读取不等于落盘完成，尤其不能在 Windows 结束托管进程前省略这一步。持久化确认失败时明确报告失败。

## 同轮插入

`session/prompt` 的 `mode:"steer"` 从 `@deepseek-ai/dsh-api-session-controller` `0.1.2-alpha.2` 起存在，并调用 `agent.steer`。Adapter 只在可解析的规范 SemVer 不低于该版本时声明 `capabilities.steer`。读不到版本或更低时不声明，`turn.steer` 返回 `unsupported`。已收录的 `0.1.2-rc.1`、`0.1.5` 与 `0.1.7` 画像都高于这个门槛。

`turn.steer` 只对当前未结束的活跃 Turn 发送 `mode:"steer"`，不取消、不另起 Turn。空文本是 `invalidRequest`。目标 Turn 不活跃是 `invalidState`。插入用的 `requestId` 不进入待绑定的 prompt 集合，因此中途出现的用户消息不会把已经关联好的 Turn 再绑一次。

RPC 回执 `{accepted:true}` 不够。Adapter 等待同一 `requestId` 的 `agent/inbox/spliced`。`target:"next-step"` 才返回 `{accepted:true}`。`target:"next-turn"`（中止时 inbox 会改投下一轮）是 `invalidState`，不把这次插入算进当前 Turn。等到关联宽限仍没有 splice，是 `protocolError`，并保留该 `requestId`，避免迟到回声再去绑定。`session/agent-busy` 与 `session/steer-unavailable` 只在这次插入里映射为 `invalidState`；`turn.start` 遇到 `session/agent-busy` 仍是 `sessionBusy`。

Adapter 不发布 `userMessage`。历史仍按现有日志投影把同一原生 Turn 里的用户文本收进该轮输入，不另分组。忙时 `turn.start` 仍是 `sessionBusy`。

本机没有可运行的 `dsh`，未做实机插入。行为依据已发布的 `0.1.2-alpha.2` 包：`mode` 为 `'queue' | 'steer'`，且 `mode === "steer"` 时调用 `agent.steer`。单元测试覆盖版本门槛、请求参数、非活跃目标、`next-step` / `next-turn`、回声不重新绑定、忙时 `turn.start`，以及不发布 `userMessage`。

## 真实 CLI Gate

提供基于本地 SSE 模型、隔离临时数据和真实 CLI 的生命周期 Gate：`tools/gate-dsh/lifecycle.real.test.mjs`。通过 `CODEXHOST_DSH_REAL_COMMAND` 指定原生命令，缺少命令时明确跳过。Gate 覆盖流式输出、取消、空/保留历史编辑、冷恢复、默认配置保持、源历史不变和活动关闭；不覆盖原生 Fork、工具调用恢复和限时提问，这些由定向测试与单独的真实 CLI 探测验证。四个已验证版本的平台、命令、耗时和未验证边界见[版本验证记录](dsh-version-validation.md)。不把默认配置验证推广为任意非默认配置，也不证明独立第三方客户端或任意后台工具进程的退出。
