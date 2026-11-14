# 委派问题交互：读取、回答与一次性通知

受委派方执行中提出问题时，委派方可以读取同一份挂起请求并提交答复。问题与答案沿用既有 Desktop 协议；Host 只补登记、查询、一次性答复和失效管理，不另建问题语义模型。

## 现有路径与职责

- 含多选字段的外部 Question 使用上游共享卡片及 Host 值答复接口；它们不登记为原生 `requestUserInput`，本委派接口暂不列出这些卡片。
- 外部 Harness 的其他结构化 Question 仍由现有 projector 生成 Desktop 请求；委派方看到的 `request` 就是该请求的 params，答复仍由原有 `parseResponse` 映射选项文本，再交给 Adapter 的 `interaction.respond`。
- 原生 Codex 的 `item/tool/requestUserInput` 沿已有服务端请求 ID 映射返回；共享服务中的 Web 与委派复用客户端通道的挂起请求和回复路径，不先转成 HostQuestion 再转换回去。
- 原生 Codex 的异步选择题来自 `delivery: "async"` 的 `agentMessage.questions`。`NativeAsyncQuestions` 由 `OfficialRuntimeScope` 持有，统一解析、保存待答事实和领取状态；同一原生运行范围内的 Desktop 连接、共享 Web 服务与委派共用同一实例。答复复用原生客户端通道协议：读取最近五轮检查已答消息，活动轮使用 `turn/steer`，空闲时使用 `turn/start`；它不是服务端 RPC 请求，不发送 `serverRequest/resolved`。
- `QuestionInteractions` 管理其余已有 Desktop 请求的登记和一次性答复；原生客户端通道的同步请求与 `NativeAsyncQuestions` 分别由各自协议处理者持有。协议处理者负责原有解析与校验。
- Desktop 的显示、答复、取消和非法输入语义不变。外部 Question 的非法 Desktop 答复仍按原路径转换为取消；原生答复仍直接转发。
- `approval` 不进入本接口，权限规则不变。请求只来自结构化事件，不从聊天、工具文本或屏幕重建。

## 读取与答复

当前 Runtime 的 `thread read` / `thread wait` 在 JSON 和 compact 输出中均返回 `pendingQuestions`；无问题时是空数组。旧 Runtime 没提供该字段时，CLI 不凭空补成空数组。每项包含不透明 `interactionId`、`kind`、所属 `turnId`、可选的 `expiresAt` 和原请求参数 `request`：

```json
{
  "interactionId": "opaque-host-request-id",
  "kind": "requestUserInput",
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

同步题（`kind: requestUserInput`）的文件内容使用现有回复 result 结构，例如 `{"answers":{"decision":{"answers":["Continue"]}}}`。使用请求中的选项文本或原协议允许的文本答案；选项文本到 Harness 原始值的转换由已有解析器负责。CLI 只读取 JSON 并传递，不额外解释题目。

异步题的 `kind` 为 `requestUserInputAsync`，`request` 保留单题的 `title`、可选的字符串数组 `options`，以及原生 `threadId`、`turnId`、`itemId` 和 `questionItemId`。答案文件使用 `{"answer":"Markdown"}`，可选择选项或填写自由文本；无内容的答复在协议边界拒绝并保留待答题目。每题独立结算，回答一题不会关闭同条消息的其他题目。CLI 无需自行构造原生消息标记或题目标识。

MCP 使用 `thread_answer`，参数为 `thread`、`interactionId` 和相同的 `result`；HTTP 复用 `/v1/thread/answer`，不增加另一种题目或答案模型。

结果不表示受委派方工作已经成功，仍需 read/wait 查看后续执行。非法输入、取消及下游失败沿原有回复路径处理，不保证请求保留可重试；失败后先重新读取。无法解析文件或缺少回复参数时不提交；未知、过期或已被领取的凭证返回 `QUESTION_NOT_PENDING`，凭证属于另一 Thread 时返回 `INVALID_ARGUMENT`。

## 生命周期与通知

- 已有同步 Desktop 请求在交回原处理者前领取。原生异步题的 Web 与委派凭证可以不同，但领取按同一个原生题目身份决定，至多提交一次；未知结果保留领取。
- 同步请求沿用 Host 实例和登记编号生成凭证；原生客户端及异步请求的凭证绑定当前 Host / 原生运行代次。原生题目身份不充当可跨代使用的公开凭证。
- 异步题允许原生 Agent 继续执行。已答题不会被重复 item 或旧历史重新打开；明确的原生校验拒绝（`-32600` / `-32602`）释放领取，其余失败保留未知结果占用，不自动重发。
- 原生异步题沿用最近五轮的历史恢复窗口；原 Turn 结束不会使未答题失效。答复前重新读最近五轮，送到当前活动 Turn，或在空闲时启动新轮。回执中的 `turnId` 标识提问来源，实际后续执行仍以 read/wait 为准。
- Desktop 的原生输入保持透传；观察到原生答案后撤下同题。与 Desktop 同时提交的跨客户端原子互斥仍不由原生协议提供，不能把 Web/委派的一次领取扩称为 Desktop 的全局锁。
- Web 的 Skip 只隐藏该 Web 凭证的题目投影，不结算待答事实；委派仍可回答，不发送原生答案或取消。原生运行代次重建后仍可从历史恢复。
- 同步请求在超时、取消、Turn 结束或原生解决后失效。异步事实由原生运行范围在后端代次停止时清理，关闭单个 Desktop 连接不清理其他连接共用的事实；客户端重置不释放其他连接共用的题目事实或领取。原生关闭 Thread 后仍沿用原客户端清理规则，不增加持久化问题状态。
- 原生启动请求按对应 RPC 响应结算，活跃轮按匹配 Turn 的终态结算，输出写完后才释放断连排空约束。尚未完成的请求记录提前到达的终态，避免晚响应复活旧轮；旧轮结束不清理下一轮的启动。
- watch 注册和轮询都优先判断终态，已结束返回 `alreadyTerminal` 或报告终态结果；仅非终态存在待答题时返回 `alreadyNeedsInput` 或报告 `needsInput`。题目不改变 Thread 状态，异步题可以在空闲时仍待答；收到终态后应 read 查看未答题。答复后可重新 watch。
- wait 遇到待处理请求即返回 `timedOut: false`。通知投递机制保持原有语义，调用者收到通知后应读取当前状态。

## 实现入口

| 文件 | 职责 |
| --- | --- |
| `packages/host-runtime/src/question-interactions.ts` | 请求登记、读取、一次性领取和失效 |
| `packages/host-runtime/src/native-async-questions.ts` | Web 与委派共用的原生异步题事实、领取和回复协议 |
| `packages/host-runtime/src/app-server-host.ts` | 接通原有外部及原生请求、回复和关闭事件 |
| `packages/protocol-core/src/codex-question.ts` | 外部 Question 的 Desktop 投影及答复解析 |
| `packages/host-runtime/src/harness-delegation-coordinator.ts` | read/wait 入口 |
| `packages/host-runtime/src/delegation-watch.ts` | 一次性 needsInput/终态通知 |
