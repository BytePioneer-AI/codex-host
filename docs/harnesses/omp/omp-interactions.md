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

## 原生依据与验证边界

核查版本为本机 OMP `18.0.6`，源码参考提交 `b4e8e856ad40294167679a3f88417c07429fe59b`：

- [RPC 模式](https://github.com/can1357/oh-my-pi/blob/b4e8e856ad40294167679a3f88417c07429fe59b/packages/coding-agent/src/modes/rpc/rpc-mode.ts)：`requestRpcSelect` 发出对齐的 `optionDetails`，对话响应保留超时与取消区别。
- [Ask 工具](https://github.com/can1357/oh-my-pi/blob/b4e8e856ad40294167679a3f88417c07429fe59b/packages/coding-agent/src/tools/ask.ts)：RPC 使用 select/editor 组合提问流程。
- [权限说明](https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md)：权限策略属于 OMP。

聚焦测试覆盖选项说明、非法元数据、有效/非法/重复答案、原生取消与超时回包，以及既有审批行为。另在隔离临时目录运行 OMP 18.0.6 原生 RPC 扩展命令，实际收到带 optionDetails 的 select，返回 JSON 选项后获得原生成功通知；该探针不发起模型请求。合成进程测试与原生 RPC 探针不等同于真实模型或 Desktop 全链路验收。

原生回归测试通过 `CODEXHOST_OMP_NATIVE_TEST_COMMAND` 指向已安装的 OMP（当前测试包装器用于 macOS/Linux）。测试使用隔离 Agent 目录和 localhost 模型夹具，经公共 Adapter 创建 Session，检查真实模型请求中包含 `ask`，由原生工具触发 Host Question、保留选项说明，再把 Host 答案送回原生工具及下一次模型请求。此测试在普通 `rpc` 下因缺少 `ask` 失败，切换 `rpc-ui` 后通过；不调用外部模型。
