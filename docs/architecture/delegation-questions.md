# 委派问题交互：读取、回答与一次性通知

受委派方执行中提出问题时，委派方可以读取同一份挂起请求并提交答复。问题与答案沿用既有 Desktop 协议；Host 只补登记、查询、一次性答复和失效管理，不另建问题语义模型。

## 现有路径与职责

- 外部 Harness 的结构化 Question 仍由现有 projector 生成 Desktop 请求；委派方看到的 `request` 就是该请求的 params，答复仍由原有 `parseResponse` 映射选项文本，再交给 Adapter 的 `interaction.respond`。
- 原生 Codex 的 `item/tool/requestUserInput` 参数原样登记；答复经已有服务端请求 ID 映射返回，不先转成 HostQuestion 再转换回去。
- `QuestionInteractions` 只保存一份挂起请求和回复回调，不判断选项、必填、多选或自由文本规则。协议处理者负责原有解析与校验。
- Desktop 的显示、答复、取消和非法输入语义不变。外部 Question 的非法 Desktop 答复仍按原路径转换为取消；原生答复仍直接转发。
- `approval` 不进入本接口，权限规则不变。请求只来自结构化事件，不从聊天、工具文本或屏幕重建。

## 读取与答复

`thread read` / `thread wait` 在 JSON 和 compact 输出中均返回 `pendingQuestions`；无问题时是空数组。每项包含不透明 `interactionId`、所属 `turnId`、可选的 `expiresAt` 和原请求参数 `request`：

```json
{
  "interactionId": "opaque-host-request-id",
  "turnId": "turn-1",
  "request": {
    "threadId": "child",
    "turnId": "turn-1",
    "itemId": "item-1",
    "isBlocking": true,
    "questions": [{
      "id": "decision",
      "header": "Question",
      "question": "Continue?",
      "options": [{ "label": "Continue", "description": "Keep going" }],
      "isOther": false,
      "isSecret": false
    }]
  }
}
```

```bash
codexhost thread answer <thread> --interaction <id> --answers-file <file>
```

文件内容直接使用现有回复 result 结构，例如 `{"answers":{"decision":{"answers":["Continue"]}}}`。使用请求中的选项文本或原协议允许的文本答案；选项文本到 Harness 原始值的转换由已有解析器负责。CLI 只读取 JSON 并传递，不额外解释题目。

结果不表示受委派方工作已经成功，仍需 read/wait 查看后续执行。非法输入、取消及下游失败沿原有回复路径处理，不保证请求保留可重试；失败后先重新读取。无法解析文件或缺少回复参数时不提交；未知、过期或已被领取的凭证返回 `QUESTION_NOT_PENDING`，凭证属于另一 Thread 时返回 `INVALID_ARGUMENT`。

## 生命周期与通知

- Desktop 与委派方共享一个请求，只能被领取一次；交回原处理者前即领取，避免并发回复或不明确的发送结果导致重复提交。委派方答复后关闭 Desktop 中同一问题。
- 对外凭证由 Host 实例标识和请求编号派生，不使用可复用的 Adapter 局部 ID。会话恢复或 Host 重建后，旧答案不能命中新问题。
- 超时、取消、Turn 结束或原生关闭事件使请求失效。待处理信息只存在于 Runtime 内存；不恢复历史问题。
- 原生启动请求按对应 RPC 响应结算，活跃轮按匹配 Turn 的终态结算，输出写完后才释放断连排空约束。尚未完成的请求记录提前到达的终态，避免晚响应复活旧轮；旧轮结束不清理下一轮的启动。
- watch 在问题出现或任务结束时通知一次。注册时已存在问题返回 `alreadyNeedsInput` 及当前请求，不新增通知；已结束返回 `alreadyTerminal`。答复后重新 watch 等待后续。
- wait 遇到待处理请求即返回 `timedOut: false`。通知投递机制保持原有语义，调用者收到通知后应读取当前状态。

## 实现入口

| 文件 | 职责 |
| --- | --- |
| `packages/host-runtime/src/question-interactions.ts` | 请求登记、读取、一次性领取和失效 |
| `packages/host-runtime/src/app-server-host.ts` | 接通原有外部及原生请求、回复和关闭事件 |
| `packages/protocol-core/src/codex-question.ts` | 已有外部 Question 的 Desktop 投影及答复解析，未为委派改写 |
| `packages/host-runtime/src/harness-delegation-coordinator.ts` | read/wait/answer 入口 |
| `packages/host-runtime/src/delegation-watch.ts` | 一次性 needsInput/终态通知 |
