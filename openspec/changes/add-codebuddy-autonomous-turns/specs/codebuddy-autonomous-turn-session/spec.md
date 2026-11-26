# Spec Delta

## Purpose

CodeBuddy 与 WorkBuddy 共用 Session 对原生 unsolicited drain 的受限实时观测、Turn 互斥和交互归属。

## ADDED Requirements

### Requirement: Native unsolicited intervals SHALL become public autonomous Turns

Session SHALL 声明 `autonomousTurns.observe`，把同一连接的 unsolicited 公告至 `session_end` 区间投影为一个公共自主 Turn，依次发出 `turn.autonomous.started`（`input: []`）、`turn.started`、普通 Items 和唯一 `turn.completed`。requestId SHALL NOT 被视为区间唯一身份。

#### Scenario: An idle interval ends

- **WHEN** 原生在空闲时发出公告、内容和 `session_end`
- **THEN** Session SHALL 建立一个自主 Turn，并在终态到达时结束它
- **AND** 未请求取消时 SHALL 以 succeeded 表示实时区间完成，不表示业务成功

#### Scenario: Request identity changes during admission

- **WHEN** 终态或内容的 requestId 与公告不同
- **THEN** Session SHALL 仍按同一连接的开放区间接收内容和终态

### Requirement: Autonomous intervals and Host Turns SHALL NOT mix

自主 Turn 活动时，Host `turn.start` SHALL 返回 `sessionBusy`；Host 准入读取历史或前台取消后重建连接期间若出现开放自主区间，也 SHALL 在继续准入前登记并拒绝该 Host 请求，同时忽略普通 `session/load` 历史回放；重连失败时 SHALL 清理候选连接的自主缓冲与等待交互。Host Runtime SHALL 区分前台准入中与已接纳的活动 Turn，仅在明确确认由自主 Turn 占位且输入未被接纳时延后自动出队并在自主 Turn 成功结束后推进，不暂停队首也不吞掉其他启动失败。等待公共身份的原生串行区间 SHALL 分别保留内容，并在前一公共 Turn 终态后按序发布；全部暂存 SHALL 合计受 2048 帧 / 4 MiB UTF-8 约束，空区间和等待交互也计入，超限 SHALL fault。只有开放区间未结束又收到公告才 SHALL 判为重叠。

#### Scenario: Serial intervals reuse a request ID during finalization

- **WHEN** 前一公共 Turn 尚在收尾，原生依次公告并结束多轮且复用 requestId
- **THEN** 每个区间 SHALL 获得独立公共 Turn，内容不得串入其他区间
- **AND** SHALL NOT 因公共 Turn 尚未收尾而判为重叠

#### Scenario: A native interval overlaps

- **WHEN** 前一区间未收到 `session_end` 又收到公告
- **THEN** Session SHALL 按协议错误 fault，并终结活动 Turn

#### Scenario: Aggregate pending output exceeds the allowance

- **WHEN** 多轮合计暂存或空轮数量超过总额度
- **THEN** Session SHALL fault，不得因每轮单独低于上限而继续累积

#### Scenario: An open drain arrives during post-cancel reconnection

- **WHEN** 前台 Turn 取消后由下一次提交触发连接重建，新连接在回放普通历史的同时公告一个未结束的 drain
- **THEN** 普通历史回放 SHALL 被忽略，开放 drain SHALL 在继续准入前登记为自主 Turn
- **AND** 该前台提交 SHALL 返回 `sessionBusy` 而不得下发 prompt；若重建失败，候选连接的自主缓冲与交互等待 SHALL 被清理

#### Scenario: A queued foreground Turn races with a back-to-back autonomous drain

- **WHEN** 前台 Turn 完成后紧接发布自主 Turn，Host 同时尝试自动推进队首排队输入
- **THEN** 输出流 SHALL NOT 因前台准入态冲突而中断
- **AND** 自主 Turn 占位期间队首 SHALL 保持未暂停且仅在自主 Turn 成功结束后发送一次

### Requirement: Native intervals SHALL own Interactions and lifecycle settlement

已公告未结束的区间 SHALL 拥有 permission/question，等待自身公共身份后发布；前一 Host prompt 的本地完成状态 SHALL NOT 覆盖该归属。取消后到达、或等待身份时被取消的请求 SHALL 返回原生 cancelled，且 SHALL NOT 发布新的 Interaction。发送原生 `session/cancel` 前 SHALL 验证目标 Turn 仍拥有原生执行权；已结算或已让位给自主区间的前台 Turn SHALL 返回 `invalidState` 而不取消后续自主区间。取消 SHALL 调用原生取消并关闭 Interaction，收到 `session_end` 及完成取消后重连均 SHALL 受 30 秒上限约束，超时或失败时按 fault 释放 Session 而不永久停留在 `sessionBusy`。close/fault SHALL 终结活动 Turn、释放暂存和交互等待。

#### Scenario: A drain approval precedes Host completion microtasks

- **WHEN** Host prompt 已返回，下一轮公告和 permission/question 在本地完成处理前到达
- **THEN** Interaction SHALL 等待并绑定自主 Turn，不能绑定旧 Host Turn

#### Scenario: Cancellation rebuild receives more intervals

- **WHEN** 取消后重建连接期间，新连接收到连续完整区间
- **THEN** 取消轮 SHALL 仅有一个 cancelled 终态，后续区间 SHALL 分别重放

#### Scenario: Cancellation precedes Interaction publication

- **WHEN** permission/question 在取消后到达，或在其等待身份期间发生取消
- **THEN** 原生 SHALL 收到 cancelled，且 SHALL NOT 重新发布审批或提问 UI

#### Scenario: Cancel targets a foreground Turn during pending terminal history

- **WHEN** 前台 prompt 已结算、终态历史读取尚在挂起且原生已公告下一 drain，收到旧前台 Turn 的取消请求
- **THEN** Session SHALL 返回 `invalidState` 且 SHALL NOT 发送原生 `session/cancel`
- **AND** 下一 drain SHALL 保持未取消状态并按自身生命周期结算

#### Scenario: Autonomous cancel recovery stalls

- **WHEN** 自主 Turn 取消收到 `session_end` 后，连接退休或重建超过 30 秒未完成
- **THEN** Session SHALL fault 并终结活动 Turn、释放候选连接，避免永久停留在 `sessionBusy`

#### Scenario: The Session closes with an unpublished Interaction

- **WHEN** close/fault 发生于公共身份尚未就绪时
- **THEN** Session SHALL 解除交互等待并丢弃该暂存区间

### Requirement: Limited live observation SHALL NOT infer persisted autonomous identity

自主 Turn SHALL NOT 读取历史推断终态、成功、身份或分组，也 SHALL NOT 生成 `nativeTurnRef`。无原生身份的终态 SHALL 带 `ephemeral: true`，通过 Host 临时投影完成收尾，不写入 Host Turn 身份映射。前台 Turn 观察到 drain 交叠时 SHALL 禁用无 `userMessageId` 的单轮回退，压缩确认 SHALL 仅消费可归属当前前台 Turn 自身（含其前置压缩边、排除 drain 压缩）的原生记录。只读历史 SHALL 保持原生行投影规则；重开后按原生落盘展示，分组和终态可能与实时不同。此能力 SHALL 明确标为受限实时支持，不承诺两者一致。

#### Scenario: History has no success or contains unrelated meta rows

- **WHEN** 原生区间已结束，但历史不存在、未完成或含失败 Host 的隐藏输入
- **THEN** 自主 Turn SHALL 按实时区间结束，不认领任何历史行或 Native Turn Ref

#### Scenario: The Host consumes a successful unanchored terminal

- **WHEN** 实时自主区间以无 nativeTurnRef 的成功终态结束
- **THEN** Host SHALL 接受其 ephemeral 标记、投影完成并继续队列，不得因缺少原生身份将其改判失败

#### Scenario: A Session is reopened

- **WHEN** 用户重开含自主输出的会话
- **THEN** 历史 SHALL 按既有原生输入行规则展示，不按空输入、时间或行序猜测实时区间
