# OMP 原生插话

RPC `{type:"steer", message}` 将输入交给原生 steering 队列，工具批次结束后、下一次模型请求前注入。原生接口及工具边界见 [OMP RPC](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md) 与 [agent loop 契约](https://github.com/can1357/oh-my-pi/blob/main/packages/agent/src/types.ts)。Host 的 `accepted: true` 承诺接纳到当前 Host Turn，不能仅凭一个成功入队回执在所有阶段声明能力。

Session 只在当前请求的 Turn 有根级 Tool 未结束、且没有开始取消或终态结算时声明 `capabilities.steer=true`。`turn.steer` 在调用 RPC 前重新检查同一窗口和目标 Turn ID；没有跨 await 的预检查缓存。文本输出、空闲和终态阶段不声明，Host 沿既有停止后重发路径处理。Adapter 不取消工具、不自行开始替代 Turn，也不重复发布 Host 已负责投影的用户输入。

原生明确返回相关 `steer` 请求的 `success:false` 时，Adapter 才返回未接纳错误，允许 Host 使用原有退路。传输断开、回执超时或输入钩子已经处理但未确认入队等未知结果继续抛出，不能包装成未接纳，防止已消费的输入被重发。取消期间不接纳新的 steer。

## 历史与完成

现有历史解析按原生用户条目分轮，实时同轮插入可能在刷新后表现为后续用户条目；本补丁不另存一份分组记录。Turn 开始终态身份结算后关闭新输入窗口，并等待已发出的 RPC 结算，再读取历史。新用户条目数必须等于原提问加明确接纳的插入数，原提问仍是该 Host Turn 的身份；数量不符继续报错，不能悄悄改绑到插入消息。

## 验证边界

定向测试覆盖根工具窗口的开闭、取消期间拒绝、明确拒绝与未知回执的区别、连续输入、终态与回执竞态、原生历史数量及用户消息投影归属。真实 Gate 位于 `tools/gate-steer/adapter.real.test.mjs`，默认跳过；用 `CODEXHOST_STEER_REAL_HARNESSES=omp` 显式选择。它检查单次、连续两次和工具结束附近的输入；被接纳的输入必须在原 Host Turn 恰好回复一次，不能以排到下一轮冒充通过。Gate 使用已有登录和所选模型，留下原生测试 Session，并清理临时工作目录。

macOS / OMP 18.12.6 已运行单次、连续两次和工具结束附近的真实 Gate。Desktop 26.1103.31037 的隔离窗口使用既有 `openai-codex / gpt-5.6-sol`、High 配置，在前台 sleep 命令执行时通过 Composer「排队」「引导」完成同轮插话；原工具成功完成，只有一个 Host Turn，回复遵循补充要求。验证必须识别实际 shell 命令，不能把 OMP 投影到同一 commandExecution 通道的 thinking 工具当作该命令。该结果不覆盖所有 Model / Provider 组合、延迟 input hook、多窗口、远端或其他 OS。
