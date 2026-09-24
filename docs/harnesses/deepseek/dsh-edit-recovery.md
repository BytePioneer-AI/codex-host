# DSH 消息修订、恢复与原生停止确认

Adapter 已在 DSH `0.1.2-rc.1`、`0.1.5-rc.1`、`0.1.5-rc.2`、`0.1.5-rc.3` 和 `0.1.7-rc.1` 验证，通过 codexhost 托管、认证的 Web Remote 创建、恢复和 Fork 原生 Session；低于 `0.1.7-rc.1` 的现代版本按 V3 尝试，`0.1.7-rc.1` 及更高规范 SemVer 版本按 V4 尝试，但未通过真实 Gate 的版本不宣称兼容。`0.1.7-rc.2` 当前只有源码协议审计和自动化路由回归，尚未完成真实 CLI 生命周期 Gate。Legacy 协议已移除。

修订上一条消息使用原生历史操作，仅回滚最后一个回合；Fork 根据原生 seed 标记和已验证的历史前缀确认继承关系，不改写源会话。恢复通过公开历史 API 读取，保持 Native Session ID 和原生配置语义。

015 的原生 Fork 可能继承下一回合的待处理输入。Adapter 在接纳新子会话前，仅通过原生队列接口移除可证明来自继承前缀的待办，再读取确认，避免冷恢复重新执行已经回滚的输入；来源不明或无法确认时明确失败。

| DSH 版本 | 原生历史与流式 | Checkpoint |
| --- | --- | --- |
| `0.1.2-rc.1` | V0 日志，持久化 Assistant chunk | `turn-end:` |
| `0.1.5-rc.1` / `0.1.5-rc.2` / `0.1.5-rc.3` | V3 日志，独立 Assistant baseline/start/chunk/end 与持久化 message/attempt 结算 | `v3-turn-end:`，附带精确版本 locator |
| `0.1.7-rc.1` | V4 日志，增加 `developer/message`、V4 surface 引用、image offload、workspace changes、V4 Assistant 块校验和 `forked` synthetic closer | `v4-turn-end:`，附带精确版本 locator |

V3 系统消息参与原生 surface 引用和替换，不作为用户回合展示。Assistant 流重连后以原生 baseline 和持久化结算去重。两个格式的 checkpoint 不能混用：DSH 原生迁移可能重编号 seq，旧 checkpoint 不可用于 V3 Fork/回滚，Adapter 在修改原生会话前拒绝跨格式或与当前 CLI 版本不匹配的 checkpoint；同为 V3 的 Session Ref 可在升级后尝试恢复，仍须通过实际历史解析。codexhost 不迁移原生文件，也不保证新日志可以由旧版 DSH 打开。

015 文本增量在最终消息持久化前实时展示。若 DSH 放弃或重试一次生成，已经展示的部分输出标记为取消，新的尝试独立显示；重新读取历史时只保留 DSH 持久化的可见消息。不会将失败尝试的文本拼接进成功答案。

DSH V0/V3/V4 的可见原生思考增量也会实时展示。流式末尾换行先暂存，由最终消息确定权威文本；仅末尾换行数量不同不会取消临时思考 Item。Codex 思考预览与 `thinking` 卡片不显示末尾换行，正文段落换行保留，原生历史仍不改写。临时思考被最终消息修订、移除或被放弃时，旧 Item 明确标记取消；新的最终 Item 只显示原生权威内容。重连按原生 Assistant baseline 去重，冷恢复仅从 DSH 持久化历史读取最终思考。带非空 `command` 参数的 `pwsh` Tool 使用可展开命令框显示完整命令和有界输出；缺少有效命令时仍按普通 Tool 显示。

活动 Session 关闭先请求取消，再等待对应原生 `turn/end`。未关联请求不能被另一个自主 Turn 的终态遮蔽；故障先于关闭时，本地清理不能证明原生停止；关闭期间晚到的接受回执仍获得终态。无法确认停止时明确拒绝 close。

015 正常会话关闭和 Fork 队列清理后，还会通过认证的原生 `HEAD /api/session.export` 等待日志写入完成；该请求不下载日志内容。原生回执和内存历史读取不等于落盘完成，尤其不能在 Windows 结束托管进程前省略这一步。持久化确认失败时明确报告失败。

提供基于本地 SSE 模型、隔离临时数据和真实 CLI 的生命周期 Gate：`tools/gate-dsh/lifecycle.real.test.mjs`。通过对应的 `CODEXHOST_DSH_REAL_COMMAND` 指定原生命令，缺少命令时明确跳过。`0.1.5-rc.3` 和 `0.1.7-rc.1` 的 Gate 均已通过；Windows、Node.js `v24.11.0`、Vitest `4.1.10` 的命令、耗时和未验证边界见[版本验证记录](dsh-015rc1-validation.md)。

Gate 覆盖流式输出、取消、空/保留历史编辑、冷恢复、默认配置保持、源历史不变和活动关闭。此前两个支持版本均已在 Windows 运行此 Gate；rc.2 已在固定依赖和启动时加载 profile 的 macOS 环境中通过。不把默认配置验证推广为任意非默认配置，也不证明独立第三方客户端或任意后台工具进程的退出。具体命令、覆盖率及 rc.2 的安装限制见 [版本验证记录](dsh-015rc1-validation.md)。
