# Tasks

## 1. 原生证据与能力声明

- [x] 1.1 只读核对三个发行（CodeBuddy CLI 2.157.0、WorkBuddy 国际版 5.7.6、WorkBuddy 国内版 5.6.2 / CLI 2.147.0，含精简 bundle）的 unsolicited drain 实现与帧契约；在共用 capabilities 声明 `autonomousTurns.observe`。验证：三个 bundle 均命中 `announceUnsolicitedTurn` / `buildUnsolicitedTurnUpdate` / `drainBackgroundTaskNotifications`，并记录文件哈希与 ACP 文档；WorkBuddy 测试断言能力声明。

## 2. 自主 Turn 生命周期

- [x] 2.1 在共用 Session 接入开始帧、内容帧与 `session_end`，按原生 Turn 顺序与已消费边界关联落盘 Turn 的终态与 `nativeTurnRef`；Host Turn 收尾窗口内的帧按 requestId 有界暂存后按序重放，连续原生轮排队，自主 Turn 期间保持 `sessionBusy`。验证：新增聚焦测试覆盖空闲单轮、Host 接收前已落盘、持久化先于 Host 终态快照、Host 准入竞态、串行三轮、真正重叠 fault、连续多轮、暂存重放、busy 拒绝、取消、关闭与无归属 `session_end`。
- [x] 2.2 取消、关闭与 fault 收敛到既有 `#finish` / `#resumeAfterCancel` 路径；暂存期 Interaction 等待该轮公共身份后归属自主 Turn，close/fault 时解除。验证：取消后恰好一个 cancelled 终态、重建连接后可继续下一轮；自主 Turn 的审批与提问归属其 turnId，重建期间收到的新轮可重放。
- [x] 2.3 只读历史把原生注入的 meta 输入行投影为自主 Turn 的空输入，同一原生轮的相邻隐藏输入行归为一个 Turn。验证：历史投影测试覆盖空输入、多行归组与 `startsNewUserRequest`、本地命令、`/compact` 既有规则。

## 3. 文档与验证

- [x] 3.1 更新 CodeBuddy 与 WorkBuddy 集成文档，写明帧契约、三个发行证据、边界与未在线验收的限制。
- [x] 3.2 按改动运行格式、lint、typecheck、`build:typescript` 与 codebuddy/workbuddy 聚焦测试并记录退出码；新增测试在实现前逐条确认失败。
