# Pi 原生插话

RPC `{type:"steer", message}` 将输入交给原生 steering 队列，工具批次结束后、下一次模型请求前注入。原生接口及工具边界见 [Pi RPC Commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md)。Host 的 `accepted: true` 承诺接纳到当前 Host Turn，不能仅凭一个成功入队回执在所有阶段声明能力。

Session 只在当前请求的 Turn 有根级 Tool 未结束、且没有开始取消或终态结算时声明 `capabilities.steer=true`。`turn.steer` 在调用 RPC 前重新检查同一窗口和目标 Turn ID；Transport 在收到原生成功回执的那个事件帧再次确认目标执行尚未终结，不使用 await 恢复后的状态替代原生帧顺序。文本输出、空闲和终态阶段不声明，Host 沿既有停止后重发路径处理。正常插话不取消工具、不自行开始替代 Turn，也不重复发布 Host 已负责投影的用户输入。

写入前已确认目标不再接纳，或原生明确返回相关 `steer` 请求的 `success:false` 时，Adapter 返回未接纳错误，允许 Host 使用原有退路。传输断开、回执超时或输入钩子已经处理但未确认入队等未知结果继续抛出，不能包装成未接纳，防止已消费的输入被重发。取消期间不接纳新的 steer。

Pi 的异步 input hook 可以在原执行结束之后才完成；之后的 `queued` 只表示进入空闲 Session 的队列，不能确认送达原 Turn。此时 Transport 先读取原生终态历史，再关闭该 Thread 专属的 Pi 进程，防止未执行队列混入下一次发送。插话返回结果不确定错误，不自动重发，也不声称能撤销 input hook 已产生的副作用。来自 Desktop 队列的输入恢复原位置，但不会因原轮或后续 Turn 完成而由 Host 自动执行；用户检查影响后再决定手动发送或删除。Adapter 用保留的原生历史结算旧 Turn，不把该插话计为已接纳；旧 Turn 的真实终态发布后，Session 才报告故障，由现有恢复路径重新打开同一个 Native Session。不编辑或清空共享原生队列，不重启其他 Thread。

## 历史与完成

现有历史解析按原生用户条目分轮，实时同轮插入可能在刷新后表现为后续用户条目；本补丁不另存一份分组记录。Turn 开始终态身份结算后关闭新输入窗口，并等待已发出的 RPC 结算，再读取历史。新用户条目数必须等于原提问加明确接纳的插入数，原提问仍是该 Host Turn 的身份；数量不符继续报错，不能悄悄改绑到插入消息。

## 验证边界

定向测试覆盖根工具窗口的开闭、取消期间拒绝、明确拒绝与未知回执的区别、连续输入、终态与回执竞态、原生历史数量及用户消息投影归属。真实 Gate 位于 `tools/gate-steer/adapter.real.test.mjs`，默认跳过；用 `CODEXHOST_STEER_REAL_HARNESSES=pi` 显式选择。它检查单次、连续两次和工具结束附近的输入；被接纳的输入必须在原 Host Turn 恰好回复一次，不能以排到下一轮冒充通过。Gate 使用已有登录和所选模型，留下原生测试 Session，并清理临时工作目录。

`packages/adapters/pi/test/pi-steer-delayed-input.real.test.ts` 使用同一开关，在真实 CLI 中额外加载临时 input hook，直到原执行的 `agent_settled` 之后才释放输入。检查旧 Turn 保持成功、晚到回执不报接纳、专属进程已退出、同一 Native Session 可以恢复，以及下一轮不会执行遗留输入；只删除测试自建目录和 Session，报告保存在 `.codexhost/native-steer-real/pi-delayed-input/`。

原生依据为随包 `docs/rpc-commands.md`、`dist/core/agent-session.js`、`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`。macOS / Pi 1.4.0 已实测正常单次和连续插话，以及延迟 input hook 后恢复同一 Session 且不重放输入；单次实测不能证明所有临界时序或自定义扩展行为。macOS / Desktop 26.1103.31037 的隔离窗口实测覆盖正常工具中插话、异步 hook 晚到、原轮成功、同一 Native Session 后续输入不重放旧队列，以及删除未确认输入后普通发送。操作通过真实 Composer 的「排队」「引导」与删除按钮完成。多窗口、远端和其他 OS 另行验收。
