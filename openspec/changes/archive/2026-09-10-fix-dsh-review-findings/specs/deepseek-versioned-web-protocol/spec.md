## MODIFIED Requirements

### Requirement: Journal parsing preserves each supported format

012 profile MUST 严格读取 V0；015 profile MUST 严格读取 V3、系统 surface、序号替换、原生新增事件和独立 Assistant 流。所有入口 MUST 保持有界校验；未知 required 事件 MUST 失败，未知 ignorable 事件 SHALL 按原生格式保留而不解释其 surface 元数据。非法远端整数 MUST 保持 protocolError，不能归类为可重试 unavailable。

#### Scenario: V3 journal is loaded
- **WHEN** 创建、恢复、导入后打开或分页收到合法 V3 日志
- **THEN** Adapter SHALL 正确处理系统消息引用、PTC、流式结算、usage 及原生继承标记，且不把系统消息展示为用户回合

#### Scenario: Mixed format or broken references are received
- **WHEN** header 或已知事件来自另一格式，或者替换和来源引用不合法
- **THEN** Adapter SHALL 明确报协议错误，不静默回退或伪造历史

#### Scenario: A remote integer is malformed
- **WHEN** chunk 索引或 finish 失败诊断中本应为整数的字段非法
- **THEN** Adapter SHALL 返回 protocolError，且不因此重新打开 journal

### Requirement: Streaming and control retain native semantics

015 follow SHALL 请求 assistantStream: true，校验 baseline/start/chunk/end 的身份与顺序，在 durable settlement 后去重；012 SHALL 保留已有持久化 chunk 行为。命令、权限、审批、问题、队列和停止 MUST 继续以原生确认作为成功依据。Assistant start 的结算查找 SHALL 仅检查 startedAfterSeq 之后的事件，不重复遍历已排除的历史前缀。

#### Scenario: Reconnect resumes an assistant attempt
- **WHEN** live 连接中断后恢复 baseline 和已有 durable 事件
- **THEN** Adapter SHALL 恢复或明确结束对应尝试，且不重复完成 Host 回合或重复输出历史消息

#### Scenario: Slash command executes
- **WHEN** 用户提交原生命令或选择 permission mode
- **THEN** 012 SHALL 发送 images: []，015 SHALL 发送 submittedAttachments: []，并保留现有静态文本命令清单与输入校验

#### Scenario: An assistant starts at the current durable tail
- **WHEN** 新尝试的 startedAfterSeq 已指向当前历史末尾
- **THEN** 结算查找 SHALL 不读取历史前缀，随后仍正常发布实时文本
