# Spec Delta

## Purpose

CodeBuddy 与 WorkBuddy（国际版、国内版）共用 Session 对原生 unsolicited drain 的投影、互斥和历史一致性。

## ADDED Requirements

### Requirement: Native unsolicited output SHALL become one public autonomous Turn

当原生在没有 Host `turn.start` 时宣布并执行一轮 drain，Session SHALL 声明 `autonomousTurns.observe`，用 `turn.autonomous.started`（`input: []`）建立公共 Turn，并把该轮内容按普通 Item 规则投影，最后发出唯一的 `turn.completed`。

#### Scenario: An idle drain completes

- **WHEN** 原生在空闲时发出 unsolicited 开始帧、内容帧与 `session_end`
- **THEN** Session SHALL 建立且只建立一个自主 Turn，其 Items 来自该轮内容
- **AND** SHALL 以落盘 Turn 的 `nativeTurnRef` 与 outcome 发出唯一终态

#### Scenario: A drain succeeds after a Host Turn

- **WHEN** 上一个 Host Turn 已结束，原生随后开始并完成一轮 drain
- **THEN** 自主 Turn SHALL 在 Host 终态之后开始
- **AND** 两个 Turn SHALL 不共享 Turn ID、Item 或终态

### Requirement: Autonomous and Host Turns SHALL NOT mix

自主 Turn 持有 Session 时，Host `turn.start` SHALL 以 `sessionBusy` 拒绝；Host 启动读取历史后若已有自主 Turn，该请求也 SHALL 被拒绝。Host Turn 收尾期间到达的 drain 帧 SHALL 按原生顺序暂存，等 Host 终态后再建立自主 Turn；暂存 SHALL 有明确上限，超限按协议错误处理。原生串行多轮 SHALL 按序排队；只有前一轮尚未收到结束帧时再次开始才按协议错误处理。

#### Scenario: A Turn is requested during a drain

- **WHEN** Host 在自主 Turn 活动期间请求 `turn.start`
- **THEN** Session SHALL 返回 `sessionBusy`，且 SHALL NOT 发出该请求的 `turn.started`

#### Scenario: A drain starts while the Host Turn finalizes

- **WHEN** drain 帧在 Host Turn 尚未发出终态时到达
- **THEN** 这些帧 SHALL NOT 进入 Host Turn
- **AND** SHALL 在 Host 终态后按序重放为自主 Turn

#### Scenario: Serial native rounds arrive while a terminal read is pending

- **WHEN** 上一轮已收到结束帧，其公共终态仍在读取历史，后续原生轮依次开始并结束
- **THEN** 每一轮 SHALL 按原生顺序排队并各自获得一个自主 Turn
- **AND** SHALL NOT 因公共终态尚未发布而报并发错误

### Requirement: Cancellation and shutdown SHALL settle exactly once

对自主 Turn 的 `turn.cancel` SHALL 调用原生取消、关闭待处理 Interaction，并以 `session_end` 为唯一终态依据；超时按公共错误与 fault 规则处理。关闭与 fault SHALL 终结活动中的自主 Turn，且不得泄漏 Interaction 或延迟 Item。

#### Scenario: The user cancels an autonomous Turn

- **WHEN** Host 以自主 Turn 的 turnId 发送 `turn.cancel`
- **THEN** Session SHALL 调用一次原生取消并等待其 `session_end`
- **AND** SHALL 发出恰好一个 cancelled 终态，并在取消恢复后接受下一轮

#### Scenario: The Session closes during a drain

- **WHEN** Session 在自主 Turn 活动期间 close
- **THEN** 该 Turn SHALL 得到 cancelled 终态，输出流结束，Interaction 关闭

### Requirement: Read-only history SHALL agree with the live autonomous Turn

原生注入的 meta 输入行打开 Turn 时，只读历史 SHALL 把该 Turn 投影为空输入，并保留同一 Turn 身份、Items 与终态。显式 `startsNewUserRequest: true`、原生本地命令与 `/compact` 的既有输入规则 SHALL 保持不变。

#### Scenario: A persisted drain Turn is reloaded

- **WHEN** Host 读取包含原生 drain Turn 的历史
- **THEN** 该 Turn SHALL 以空输入、该轮 Items 和落盘 outcome 出现
- **AND** SHALL 与实时自主 Turn 使用同一 Native Turn 身份
