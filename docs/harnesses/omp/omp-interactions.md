# OMP 原生提问与工具审批

OMP 以原生 `--mode rpc-ui` 启动，使用 `extension_ui_request` / `extension_ui_response`，所有转换位于 `packages/adapters/omp`，不修改公共 Adapter 或 Host。

## 提问

必须使用 `rpc-ui`：普通 `rpc` 虽能转发扩展产生的 UI 请求，但启动时不创建内置 `ask` 工具，也不连接该工具的 UI Context。只验证扩展提问事件不能证明模型可调用 `ask`。`rpc-ui` 使用同一 RPC 协议，并启用原生交互工具；同时按 OMP 自身规则禁用 PTY，适配外部 UI。

原生 `select`、`confirm`、`input`、`editor` 分别映射为单选、确认、单行文本、多行文本问题。`select.options` 保留原生字符串作为响应值；对齐的 `optionDetails[].description` 作为选项说明展示，缺失时兼容旧版本。非法类型或长度不匹配属于协议错误，不能把说明绑定到错误选项。

OMP 的 `ask` 工具通过这些基础交互组合多问题、多选和 “Other” 文本输入。Adapter 不合并这些交互，也不自行推导新的多选协议；每次回答返回当前原生请求的一个字符串。用户响应由既有公共校验器检查，非法选项、重复和迟到响应不会送入原生进程。

超时返回 `cancelled: true, timedOut: true`，用户取消只返回 `cancelled: true`；两者都关闭待处理交互。是否在超时后选择默认答案由 OMP 自身决定，Adapter 不替用户选择。

## 工具审批

原生 `select` 的 `Approve` / `Deny` 选项映射为一次允许或拒绝；不扩大为永久允许。会话权限使用原生 `--approval-mode` 的 `always-ask`、`write`、`yolo`，与单次审批分开。

这些基础链路此前已经存在。README 中 OMP 的提问、工具审批空缺属于过期标记；此次补齐选项说明、超时语义及回归覆盖。

## 取消回合

原生 `abort` 会等待工具、持久化及延后工作退出，Adapter 默认允许 30 秒确认取消，长于 Host 插话替换的 20 秒等待界限。Host 等待超时本身不能证明原生 Session 已故障；真正未在 Adapter 界限内结束的取消仍会报告故障并清理进程。

普通取消保留 `agent_end` 与 `get_state` 的完成确认。对于已经暂停等待后台任务，或尚未开始执行的回合，原生取消可能不再产生新的 `agent_end`。收到取消成功回包后，Adapter 查询原生 `get_state`，仅在 `isStreaming: false`、`isSettled: true` 且没有已报告的后台任务、排队消息或压缩时结束取消。`session_settled`、`agent_start` 和等待期间每 250 毫秒一次的串行查询会重新核对；通知到达时若查询尚未返回，下一次查询会覆盖这个窗口。原生后台任务投递结果后可能自动启动新的生成，即使之前的 `abort` 已成功；Adapter 在原有 30 秒界限内再次取消这些生成，仍需原生状态确认。单独的取消回包或停止流式输出不能视为完成。旧 OMP 未提供 `isSettled` 时保留已收到的结束事件作为确认条件。回合结束、故障或关闭时清理重查定时器，不影响后续回合。

并发的关闭调用共同等待同一个进程清理 Promise，避免取消失败后恢复会话时把“已停止接收命令”误当作“旧进程已退出”。

OMP 18.4.3 的 `abort` 不取消会话拥有的后台作业。长时间 Bash 作业被 `wait` 观察时，停止 `wait` 会重新允许后台结果投递；单纯重复 `abort` 或重新载入同一文件不能停止该作业。取消已获原生确认、没有流式生成、工具执行、压缩或排队消息，且原生状态明确仍有后台工作时，Adapter 校验持久化文件的会话标识和 cwd，再执行一次原生 `new_session` 清理拥有的后台工作，随后用 `switch_session` 恢复原文件。这个原生运行状态重置不作为新的 Host 聊天发布；恢复后必须保持原会话标识和文件，并通过原生选择命令恢复已知模型与思考设置，再确认完全空闲才报告取消完成。扩展拒绝重置/恢复、配置恢复失败、后台工作仍未停止都保留真实故障及原有 30 秒界限。没有持久化文件或存在排队消息、压缩时不执行此恢复。

## 故障后的聊天分支

Host 创建聊天分支前会刷新源会话历史。OMP 会话故障后仍允许读取已经保存的历史：先等待原生写入进程关闭，再核对文件头的会话标识及 cwd，直接读取文件中的真实 Entry 和 checkpoint。此操作不重新启动源会话、不接受新的回合，也不清除原有故障。文件缺失、身份不匹配或进程清理失败仍返回错误。这样取消故障不会阻止从已有历史创建独立分支；同工作区和新工作树复用既有 OMP 原生 fork/cwd 绑定逻辑。

取消与分支的原生依据：OMP [v18.4.3 AgentSession](https://github.com/can1357/oh-my-pi/blob/v18.4.3/packages/coding-agent/src/session/agent-session.ts) 中的 `abort`、`newSession`、`switchSession` 和会话拥有的异步作业清理；[原生 RPC 命令](https://github.com/can1357/oh-my-pi/blob/v18.4.3/packages/coding-agent/src/modes/rpc/rpc-mode.ts)。隔离 localhost 模型探针覆盖真实后台 Bash → `wait` → 取消 → 下一回合，以及同目录和跨目录 fork 的历史前缀与独立身份。故障后历史读取另有文件夹具回归，覆盖身份/cwd 不匹配及关闭失败；这些测试不等同于完整 Desktop UI 验收。

## 原生依据与验证边界

核查版本为本机 OMP `18.0.6`，源码参考提交 `b4e8e856ad40294167679a3f88417c07429fe59b`：

- [RPC 模式](https://github.com/can1357/oh-my-pi/blob/b4e8e856ad40294167679a3f88417c07429fe59b/packages/coding-agent/src/modes/rpc/rpc-mode.ts)：`requestRpcSelect` 发出对齐的 `optionDetails`，对话响应保留超时与取消区别。
- [Ask 工具](https://github.com/can1357/oh-my-pi/blob/b4e8e856ad40294167679a3f88417c07429fe59b/packages/coding-agent/src/tools/ask.ts)：RPC 使用 select/editor 组合提问流程。
- [权限说明](https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md)：权限策略属于 OMP。

聚焦测试覆盖选项说明、非法元数据、有效/非法/重复答案、原生取消与超时回包，以及既有审批行为。另在隔离临时目录运行 OMP 18.0.6 原生 RPC 扩展命令，实际收到带 optionDetails 的 select，返回 JSON 选项后获得原生成功通知；该探针不发起模型请求。合成进程测试与原生 RPC 探针不等同于真实模型或 Desktop 全链路验收。

原生回归测试通过 `CODEXHOST_OMP_NATIVE_TEST_COMMAND` 指向已安装的 OMP（当前测试包装器用于 macOS/Linux）。测试使用隔离 Agent 目录和 localhost 模型夹具，经公共 Adapter 创建 Session，检查真实模型请求中包含 `ask`，由原生工具触发 Host Question、保留选项说明，再把 Host 答案送回原生工具及下一次模型请求。此测试在普通 `rpc` 下因缺少 `ask` 失败，切换 `rpc-ui` 后通过；不调用外部模型。
