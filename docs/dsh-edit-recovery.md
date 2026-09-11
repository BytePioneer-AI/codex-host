# DSH 消息修订、恢复与原生停止确认

仅支持 DSH `0.1.2-rc.1` 和 `0.1.5-rc.1`，均通过 codexhost 托管、认证的 Web Remote 创建、恢复和 Fork 原生 Session。Legacy 协议已移除；其他版本通过原有连接诊断明确提示这两个支持版本，并推荐 `dsh-v0.1.5-rc.1`。

修订上一条消息使用原生历史操作，仅回滚最后一个回合；Fork 根据原生 seed 标记和已验证的历史前缀确认继承关系，不改写源会话。恢复通过公开历史 API 读取，保持 Native Session ID 和原生配置语义。

015 的原生 Fork 可能继承下一回合的待处理输入。Adapter 在接纳新子会话前，仅通过原生队列接口移除可证明来自继承前缀的待办，再读取确认，避免冷恢复重新执行已经回滚的输入；来源不明或无法确认时明确失败。

| DSH 版本 | 原生历史与流式 | Checkpoint |
| --- | --- | --- |
| `0.1.2-rc.1` | V0 日志，持久化 Assistant chunk | `turn-end:` |
| `0.1.5-rc.1` | V3 日志，独立 Assistant baseline/start/chunk/end 与持久化 message/attempt 结算 | `v3-turn-end:`，附带版本 locator |

V3 系统消息参与原生 surface 引用和替换，不作为用户回合展示。Assistant 流重连后以原生 baseline 和持久化结算去重。两个格式的 checkpoint 不能混用：DSH 原生迁移可能重编号 seq，旧 checkpoint 不可用于 V3 Fork/回滚，Adapter 在修改原生会话前拒绝不匹配的引用。codexhost 不迁移原生文件，也不保证新日志可以由旧版 DSH 打开。

015 文本增量在最终消息持久化前实时展示。若 DSH 放弃或重试一次生成，已经展示的部分输出标记为取消，新的尝试独立显示；重新读取历史时只保留 DSH 持久化的可见消息。不会将失败尝试的文本拼接进成功答案。

活动 Session 关闭先请求取消，再等待对应原生 `turn/end`。未关联请求不能被另一个自主 Turn 的终态遮蔽；故障先于关闭时，本地清理不能证明原生停止；关闭期间晚到的接受回执仍获得终态。无法确认停止时明确拒绝 close。

015 正常会话关闭和 Fork 队列清理后，还会通过认证的原生 `HEAD /api/session.export` 等待日志写入完成；该请求不下载日志内容。原生回执和内存历史读取不等于落盘完成，尤其不能在 Windows 结束托管进程前省略这一步。持久化确认失败时明确报告失败。

提供基于本地 SSE 模型、隔离临时数据和真实 CLI 的生命周期 Gate：`tools/gate-dsh/lifecycle.real.test.mjs`。通过对应的 `CODEXHOST_DSH_REAL_COMMAND` 指定原生命令，缺少命令时明确跳过。

Gate 覆盖流式输出、取消、空/保留历史编辑、冷恢复、默认配置保持、源历史不变和活动关闭。两个支持版本均已在 Windows 运行此 Gate；不把默认配置验证推广为任意非默认配置，也不证明独立第三方客户端或任意后台工具进程的退出。具体命令、覆盖率和范围见 [015rc1 验证记录](dsh-015rc1-validation.md)。
