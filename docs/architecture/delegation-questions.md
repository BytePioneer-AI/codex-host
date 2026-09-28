# 委派问题交互：读取、回答与一次性通知

子 Agent 在 Turn 运行中提出结构化问题时，Turn 不会结束，父 Agent 若只用 `thread wait` 或 watch 等终态就会互相等待。本能力让父 Agent 直接读到待回答问题、把答案交回原生请求，并用一次性 watch 在出现问题时被唤醒。原生 Codex 与提供公共 Question 契约的外部 Harness 走同一条读取、回答与结算路径。

## 问题从哪来

问题只来自原生结构化请求，不从聊天正文、工具输出或屏幕反推：

- 外部 Harness 通过公共 `HarnessOutput` 的 `kind: interaction`、`type: question` 报告，通过 `interaction.closed` 报告关闭；Host 同时把它投影成 Desktop 的 `item/tool/requestUserInput`。
- 原生 Codex 通过官方 App Server 的 `item/tool/requestUserInput` 服务端请求提问；Host 在既有转发处登记请求内容与所属 Turn，并在原生 `serverRequest/resolved` 通知到达时清除。
- 只有能解析出 Thread、Turn 与问题列表的请求才进入待回答状态；无法解析的请求仍照常转发给 Desktop，但不暴露为可回答请求，Host 不猜测。

`approval` 不进入这条通道，仍按各自原生权限规则处理。问题不是权限许可，不改变任何权限策略。

## 唯一状态与两种回答入口

Host 的 `QuestionInteractions` 完整负责问题登记、读取、校验、单次答复和失效清理，用一个 Map 保存当前请求。Desktop 和 CLI 共用这个答复出口；`AppServerHost` 只把两种原生协议的解析与回复接进来。原生 Codex 的格式转换在 `official-question.ts`，外部 Harness 沿用公共 Question 契约。watch 只消费读取结果。

- 首次有效答案结算请求：交还原生请求、删除状态、并在需要时向 Desktop 发送 `serverRequest/resolved` 关闭同一问题。
- 无效答案（未知问题 ID、缺少必答项、未声明的选项、数量不符）不消耗请求，请求保持待回答，可改正后重答。
- 并发的第二份答案得到 `QUESTION_NOT_PENDING`，不会产生第二个原生回答。
- 过期、取消、Turn 结束、Runtime 关闭或原生自行解决后，旧交互 ID 不再有效。
- 回答只交回原生请求，不代替执行成功的证据；调用方仍需 `read` 或 `wait` 观察结果。

## 读取

`thread read` 快照新增 `pendingQuestions`；列表为空表示没有待回答请求。每项包含交互 ID、所属 Turn、标题、可选过期时间，以及沿用公共 Question 契约的问题（`choice`/`text`、选项值、`multiple`、`allowOther`、`optional`、`secret`）：

```json
{
  "thread": "codex://threads/<id>",
  "status": "running",
  "pendingQuestions": [
    {
      "interactionId": "…",
      "turnId": "…",
      "questions": [
        {
          "id": "decision",
          "type": "choice",
          "prompt": "Continue?",
          "options": [{ "value": "continue", "label": "Continue" }],
          "multiple": false,
          "allowOther": false,
          "optional": false
        }
      ]
    }
  ]
}
```

读取是当前事实，不需要先注册 watch；JSON 与 compact 输出都暴露该字段。原生 Codex 问题没有多选与可选项声明，Host 按协议原样保留自由度：选项的 `value` 就是原生答案字符串（选项 label），无选项问题按自由文本处理，`isOther` 映射为 `allowOther`，`isSecret` 映射为 `secret`。

## 回答

```bash
codexhost thread answer <thread> --interaction <id> --answers-file <file>
```

答案文件是问题 ID 到答案数组的 JSON 对象，例如 `{"decision":["continue"],"note":["free text"]}`；取值来自读取结果中的选项值，自由文本、`allowOther` 与无选项问题接受文本。可选问题可省略或填空数组，全部可选时允许 `{}`。命令返回被回答的 Thread、交互 ID、Turn、Harness 与 `status: "running"`，表示答复提交成功；后续是否继续或完成仍以执行事件和读取结果为准。

失败语义：

| 错误 | 含义 |
| --- | --- |
| `INVALID_ARGUMENT` | 答案或参数非法，请求保持待回答；交互 ID 属于别的 Thread 也在此列 |
| `QUESTION_NOT_PENDING` | 交互 ID 未知、已被用户或他人回答、已取消、已过期、Turn 已结束或请求所属 Runtime 已关闭 |

外部 Harness 的回答通过公共 `interaction.respond` 交回，约束由公共 Question 校验器判定；原生 Codex 的回答通过官方服务端请求回复通道，用 Host 转发时登记的请求 ID 交回，因此不会被误送到另一个进程或另一代际的请求上。

## 一次性通知

出现待回答问题与任务终态一样，都是 watch 的就绪条件：

- 已被观察的 Thread 出现问题时，本次 watch 通知一次，结果类型为 `needsInput`，通知中给出 Thread 链接、交互 ID 与 Turn，并提示重新 `read` 后回答；通知送达后该 watch 移除。
- 注册时已经存在问题（例如提问发生在注册之前）直接返回 `state: "alreadyNeedsInput"` 与当前 `pendingQuestions`，不登记 watch、不再异步重复通知；已经结束仍返回 `alreadyTerminal`。
- 通知的投递沿用既有语义：被通知 Thread 正忙时保持待送达并重试，`THREAD_BUSY` 从不视为已送达，结果未知不重试。发送、失败、超时、重注册行为不变。
- `delegate start --watch true` 使用同一 watch，因此同样会报告 `needsInput`、`alreadyNeedsInput`。

`thread wait` 使用同样的就绪条件：存在待回答问题即返回快照，`timedOut: false` 表示条件已达到，调用方按 `status` 与 `pendingQuestions` 区分“完成”和“等待回答”，不会一直等到超时。

## 边界

- 待回答请求与 watch 都只存在于当前 Host Runtime 内存，Runtime 重启后丢失，不新增持久订阅、恢复日志或数据库状态；运行时没有观察到的旧请求不会从历史文本重建。
- 不改变 Desktop 既有问题投影、普通 `thread send` 的投递语义和 `approval` 处理。
- Host 不判断业务答案，只校验协议约束。主 Agent 只在任务授权内回答，需要用户决定的问题交回用户。
- 问题不会成为新的持久状态：没有 `waiting` 标志，任务在等待回答期间保持 `running`。

## 相关实现

| 位置 | 职责 |
| --- | --- |
| `packages/host-runtime/src/question-interactions.ts` | 完整问题生命周期：登记、读取、共同答复、并发与失效处理 |
| `packages/host-runtime/src/official-question.ts` | 原生 Codex 问题及答案的协议转换 |
| `packages/host-runtime/src/app-server-host.ts` | 把原生请求、回复通道和关闭事件接到同一问题生命周期 |
| `packages/host-runtime/src/harness-delegation-coordinator.ts` | `read`/`wait` 暴露 `pendingQuestions` 与回答路由 |
| `packages/host-runtime/src/delegation-watch.ts` | `needsInput` 与 `alreadyNeedsInput` 的一次性通知 |
| `packages/host-runtime/src/codex-runtime/official-runtime-owner.ts` | 把原生 `serverRequest/resolved` 的请求 ID 改写回客户端可见 ID |
