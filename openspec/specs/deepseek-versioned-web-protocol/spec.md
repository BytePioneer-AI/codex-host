# deepseek-versioned-web-protocol Specification

## Purpose

定义仅支持 DSH 0.1.2-rc.1 与 0.1.5-rc.1 的托管 Web Remote 协议、原生会话和检查点隔离要求，同时记录 Legacy 退役、文档同步及可复现覆盖率验证边界。

## Requirements

### Requirement: Exactly two DSH executable versions are supported

Adapter MUST 仅接受 `0.1.2-rc.1` 和 `0.1.5-rc.1` 的精确版本输出，并且 MUST 删除 Legacy 协议代码、分派和专属 SDK。合法但非白名单版本 MUST 通过现有错误入口显示实际版本、仅支持这两个版本及推荐 015rc1 的中英文提示。

#### Scenario: Exact supported RC is selected
- **WHEN** `--version` 输出任意一个支持版本
- **THEN** Adapter SHALL 选择对应 Modern profile，且不探测或调用 Legacy Host API

#### Scenario: Different version is installed
- **WHEN** 版本为 011rc2、012 的其他 prerelease、013、015alpha、015rc2、正式版或带 build metadata 的变体
- **THEN** Adapter SHALL 返回不可重试 unsupported、列出精确支持版本且不启动 DSH Web

### Requirement: Journal parsing preserves each supported format

012 profile MUST 严格读取 V0；015 profile MUST 严格读取 V3、系统 surface、序号替换、原生新增事件和独立 Assistant 流。所有入口 MUST 保持有界校验；未知 required 事件 MUST 失败，未知 ignorable 事件 SHALL 按原生格式保留而不解释其 surface 元数据。

#### Scenario: V3 journal is loaded
- **WHEN** 创建、恢复、导入后打开或分页收到合法 V3 日志
- **THEN** Adapter SHALL 正确处理系统消息引用、PTC、流式结算、usage 及原生继承标记，且不把系统消息展示为用户回合

#### Scenario: Mixed format or broken references are received
- **WHEN** header 或已知事件来自另一格式，或者替换和来源引用不合法
- **THEN** Adapter SHALL 明确报协议错误，不静默回退或伪造历史

### Requirement: Streaming and control retain native semantics

015 follow SHALL 请求 `assistantStream: true`，校验 baseline/start/chunk/end 的身份与顺序，在 durable settlement 后去重；012 SHALL 保留已有持久化 chunk 行为。命令、权限、审批、问题、队列和停止 MUST 继续以原生确认作为成功依据。

#### Scenario: Reconnect resumes an assistant attempt
- **WHEN** live 连接中断后恢复 baseline 和已有 durable 事件
- **THEN** Adapter SHALL 恢复或明确结束对应尝试，且不重复完成 Host 回合或重复输出历史消息

#### Scenario: Slash command executes
- **WHEN** 用户提交原生命令或选择 permission mode
- **THEN** 012 SHALL 发送 `images: []`，015 SHALL 发送 `submittedAttachments: []`，并保留现有静态文本命令清单与输入校验

### Requirement: Session operations isolate checkpoint formats

两版 MUST 支持创建、恢复、显式导入、Fork 和最后回合回滚。015 checkpoint MUST 使用 V3 标识及版本 locator，旧 checkpoint MUST NOT 被当成迁移后有效序号；Fork MUST 验证原生继承前缀及 seed marker。

#### Scenario: Old checkpoint is supplied to V3
- **WHEN** 015 操作收到 012 checkpoint
- **THEN** Adapter SHALL 在 mutation 前返回明确失败，不使用旧 seq 创建错误 Fork

#### Scenario: Native session is imported and reopened
- **WHEN** 任一支持版本解析候选并建立映射后打开
- **THEN** Adapter SHALL 延迟读取对应格式原生历史，继续相同 Session ID，不复制或改写原生存储

#### Scenario: A V3 Fork inherits input from a discarded later turn
- **WHEN** 015 原生 Fork 的日志前缀包含下一回合入队记录，子会话权威 inbox 投影仍有可证明来自继承前缀的待办
- **THEN** Adapter SHALL 仅对新子会话逐项调用原生 `session/updateQueue` remove，并重新读取历史、验证继承前缀及队列已清空后才接纳子会话
- **AND** SHALL 保持源会话不变，不重试结果不明的删除，不清理无法证明来源的新消息；失败 SHALL 明确拒绝接纳
- **AND** 冷恢复子会话 MUST NOT 自动重放已回滚的输入

### Requirement: V3 persistence is confirmed before managed shutdown

015 Session 正常关闭以及 Fork 待办移除后，Adapter MUST 通过认证的 `HEAD /api/session.export?sessionId=...` 等待 DSH 原生 flush barrier 成功，才声称对应持久化已确认。MUST 验证 HTTP 200 与 ZIP 响应类型，不下载正文；错误、超时或重定向 MUST 明确失败，不能以固定等待替代确认。

#### Scenario: Windows closes immediately after native completion
- **WHEN** 015 的批量写入缓冲仍可能持有回合终态或取消记录
- **THEN** Adapter SHALL 在停止原生执行和关闭会话订阅后，通过原生 export HEAD 确认持久化，再允许托管进程结束
- **AND** 随后的冷恢复 SHALL 保留已确认的回合和队列状态

### Requirement: Documentation and verification match shipped support

连接/导入/消息修订及打包文档 MUST 与双版本实现一致，OpenSpec delta 和 tasks MUST 包含文档改写。项目及多语言 README SHALL 保持原样，plan/todo MUST 仅本地保存，不纳入 PR。整个 DSH Adapter 的行、语句、函数、分支覆盖率 MUST 可复现且至少 80%，目标为 80%～90%；更高覆盖率 SHALL 保留。

#### Scenario: Change is completed
- **WHEN** 交付草稿 PR
- **THEN** 文档 SHALL 明确双版本、Legacy 退役及 checkpoint 边界，验证记录 SHALL 给出实际测试命令、四项覆盖率及限制
- **AND** SHALL 完成类型、边界、构建及受影响回归，不声明未执行的真实桌面或模型验证
