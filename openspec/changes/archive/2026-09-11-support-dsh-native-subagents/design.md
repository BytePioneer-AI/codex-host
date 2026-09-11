## Context

CH 已有 `subagentDelegation`、Session 级子状态／历史通知、稳定 Host 子 Thread 映射和只读快照。DSH 012 没有 `subagent/catalog`，015 有该事件；两版都有 `subagents/list` 和使用 `{kind: subagent, parentSessionId, childSessionId, mode}` 的 journal。`inactive` 不是完成；canonical Tool 返回值并不保证持久化在 `meta`。

## Goals / Non-Goals

目标是两个精确 RC 的默认本地子智能体卡片、后台状态、实时文本／工具／真实历史、多层只读查看、继续执行、取消和恢复一致性。保持已有普通父 Session、Fork、rollback、版本和凭据边界。

不增加子会话可写 UI，不为跨进程提供方虚构内部记录，不扩展版本白名单，不更改 README，不引入另一套 Host／Renderer 专用子智能体架构。

## Decisions

1. 使用父 Session 所有的有界观察器查询原生目录和打开子 follow。父轮按原生终态结束，后台子级通过 Session 通知保持可见；关闭只读观察只释放观察资源。显式关闭普通父 Session 时先停止父执行，再请求中断所属 continuable 子级，确认目录已静止并持久化终态；失败如实报告。取消父 Turn 不取消后台子级。网络错误允许恢复并保留已知事实，不把未知状态转换成成功。
2. Opaque 子句柄保存完整父子路径；读取时逐级验证真实目录、原生 header、版本和 cwd。对继承前缀应用原生所有权规则，不接管 Fork 来源的子级。
3. 复用 Modern Session 已有的格式、流式尝试和终态校验，增加只读观察方式及活动轮快照，避免重新实现 V3 文本结算。
4. 原生 Tool 关联只使用已验证的后台回执身份或唯一的原生任务事实。同名并发不得依赖顺序猜测；缺乏强关联时保留工具语义并按真实目录子身份展示，不能把 job ID 当 Session ID。
5. 在公共 Host 内按当前父树和 Native Session 处理后代通知；打开子详情保留已观察状态。终态后不追加父轮 Item 更新，父历史读取依据当前子状态重新投影。
6. 012／015 使用既有 profile 分离。原生 `turn/end` 与被取消的待办决定终态；模型/思考档位来自子自身配置，缺失保持省略。

## Risks / Trade-offs

- 原生目录和日志均需设数量／字节／深度边界；不无限并行 follow 或保留无界内容。
- 并发发现、关闭与冷恢复可能乱序；统一生命周期和稳定句柄，避免过期回调重建资源或串到其他父树。
- 父 Fork/rollback 的历史调用不等于新父拥有旧子级，测试需证明来源隔离。
- 原生卡片由 Desktop 渲染；本次禁止浏览器自动化/computer use，采用真实 CLI、公共 Host 协议和插件验证，人工视觉验收与自动验证明确区分。

## Validation

先运行聚焦解析／观察／Host 回归，再跑整个 DSH Adapter 覆盖率（四项至少 80%，目标 80%～90%）、typecheck、lint、打包及 OpenSpec strict。真实 CLI 使用隔离 DSH_HOME 和本地 SSE 模型，覆盖默认后台、foreground fork、失败、中断、继续、实时详情和冷恢复；不调用计费模型。
