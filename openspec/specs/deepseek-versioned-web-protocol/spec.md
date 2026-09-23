# deepseek-versioned-web-protocol Specification

## Purpose

定义仅支持 DSH 0.1.2-rc.1 与 0.1.5-rc.1 的托管 Web Remote 协议、原生会话和检查点隔离要求，同时记录 Legacy 退役、文档同步及可复现覆盖率验证边界。
## Requirements
### Requirement: Journal parsing preserves each supported format

012 profile MUST 严格读取 V0；015 系列已验证版本 MUST 严格读取 V3；`0.1.7-rc.1` MUST 严格读取 V4，包括原生新增的 `developer/message`、Fork 结束原因、来源和 surface 关系。所有入口 MUST 有界校验；未知 required 事件 MUST 失败，原生 ignorable 事件 SHALL 仅按允许的格式规则处理。非法远端整数 MUST 保持 protocolError，不能归类为可重试 unavailable。

#### Scenario: V3 journal is loaded
- **WHEN** 使用 `0.1.5-rc.3` 创建、恢复、导入后打开或分页收到合法 V3 日志
- **THEN** Adapter SHALL 保留系统 surface、PTC、Assistant 结算、usage 和原生继承标记的现有投影语义

#### Scenario: V4 journal is loaded
- **WHEN** 使用 `0.1.7-rc.1` 收到合法 V4 历史或实时事件
- **THEN** Adapter SHALL 验证 V4 header、已知事件、来源/替换关系和原生 Fork closers，并只向公共 Harness 输出可表示的内容
- **AND** 系统与开发者指令 MUST NOT 被伪装成用户输入或 Assistant 回答

#### Scenario: Mixed format or broken references are received
- **WHEN** header 或已知事件来自错误格式，或替换和来源引用不合法
- **THEN** Adapter SHALL 明确报协议错误，不静默回退或伪造历史

#### Scenario: A remote integer is malformed
- **WHEN** chunk 索引或失败诊断中本应为整数的字段非法
- **THEN** Adapter SHALL 返回 protocolError，且不因此重新打开 journal

### Requirement: Streaming and control retain native semantics

V3/V4 follow SHALL 按原生能力请求 Assistant stream，校验 baseline/start/chunk/end 的身份与顺序，在 durable settlement 后去重；V0 SHALL 保留已有持久化 chunk 行为。模型、命令、权限、审批、问题、队列、停止和关闭 MUST 继续以原生确认作为成功依据。Assistant start 的结算查找 SHALL 仅检查 startedAfterSeq 之后的事件，不重复遍历已排除的历史前缀。

#### Scenario: Reconnect resumes an assistant attempt
- **WHEN** V3 或 V4 的 live 连接中断后恢复 baseline 和已有 durable 事件
- **THEN** Adapter SHALL 恢复或明确结束对应尝试，且不重复完成 Host 回合或重复输出历史消息

#### Scenario: Slash command executes
- **WHEN** 用户提交已公开的原生命令或选择 permission mode
- **THEN** V0 SHALL 发送其原生参数形式，V3/V4 SHALL 发送对应版本接受的参数形式，并保留文本输入校验
- **AND** 是否成功 SHALL 由原生响应及所需状态读回决定

#### Scenario: An assistant starts at the current durable tail
- **WHEN** 新尝试的 startedAfterSeq 已指向当前历史末尾
- **THEN** 结算查找 SHALL 不读取历史前缀，随后仍正常发布实时文本

### Requirement: Session operations isolate checkpoint formats

已验证版本 MUST 支持原生创建、恢复、显式导入、Fork 和最后回合回滚。V3/V4 checkpoint MUST 区分格式并包含精确版本 locator；旧格式或迁移前的 seq MUST NOT 被当成当前格式的有效切点。Fork MUST 验证原生继承前缀及当前格式的 marker/closer；子 Session 的继承待办只有在来源可确认且原生清理读回成功后才能接纳。

#### Scenario: Old checkpoint is supplied to V3
- **WHEN** V3 操作收到 V0 checkpoint
- **THEN** Adapter SHALL 在 mutation 前返回明确失败，不使用旧 seq 创建错误 Fork

#### Scenario: V3 checkpoint is supplied after V4 migration
- **WHEN** 原生 DSH 已把 Session 迁移至 V4，但请求仍携带 V3 checkpoint 或旧版本 locator
- **THEN** Adapter SHALL 在 mutation 前拒绝 Fork/回滚，不使用迁移前 seq

#### Scenario: Native session is imported and reopened
- **WHEN** 任一已验证版本解析候选并建立映射后打开
- **THEN** Adapter SHALL 从官方 Remote 读取对应格式的原生历史，继续相同 Session ID，不复制或改写原生存储

#### Scenario: A V3 Fork inherits input from a discarded later turn
- **WHEN** V3 原生 Fork 的日志前缀包含下一回合入队记录，子会话权威 inbox 投影仍有可证明来自继承前缀的待办
- **THEN** Adapter SHALL 仅对新子会话逐项调用原生队列 remove，并重新读取历史、验证继承前缀及队列已清空后才接纳子会话
- **AND** SHALL 保持源会话不变，不重试结果不明的删除，不清理无法证明来源的新消息；失败 SHALL 明确拒绝接纳
- **AND** 冷恢复子会话 MUST NOT 自动重放已回滚的输入

#### Scenario: A V4 Fork closes an active source turn
- **WHEN** V4 原生 Fork 在开放回合边界生成 child-owned marker、synthetic closers 或继承待办
- **THEN** Adapter SHALL 按 V4 规则验证继承前缀及 child-owned 尾部，确认待办和持久化状态后才接纳子会话
- **AND** 源会话 MUST 保持不变；验证失败 MUST 明确拒绝接纳

### Requirement: V3 persistence is confirmed before managed shutdown

V3 Session 正常关闭以及 Fork 待办移除后，Adapter MUST 通过认证的 `HEAD /api/session.export?sessionId=...` 等待 DSH 原生 flush barrier 成功，才声称对应持久化已确认。V4 MUST 使用在 `0.1.7-rc.1` 中核实的原生持久化确认途径，并在进程停止前确认；如果原有 HEAD 路由仍提供相同保证，SHALL 复用该路由。错误、超时或重定向 MUST 明确失败，不能以固定等待替代确认。

#### Scenario: Windows closes immediately after native completion
- **WHEN** V3 或 V4 的写入缓冲仍可能持有回合终态或取消记录
- **THEN** Adapter SHALL 在停止原生执行和关闭会话订阅后，通过已验证的原生确认途径等待持久化，再允许托管进程结束
- **AND** 随后的冷恢复 SHALL 保留已确认的回合和队列状态

### Requirement: Documentation and verification match shipped support

连接、导入、消息修订及打包文档 MUST 与实际已验证版本及格式一致；OpenSpec delta 和 tasks MUST 包含文档改写。整个 DSH Adapter 的行、语句、函数、分支覆盖率 MUST 可复现且至少 80%。真实 CLI Gate、自动化测试和未验证边界 MUST 分别记录；不得因 SemVer 探测成功而宣称兼容。

#### Scenario: Change is completed
- **WHEN** 向 upstream 交付 PR
- **THEN** 文档 SHALL 列出经真实 Gate 验证的 DSH 版本、V0/V3/V4 格式及 checkpoint 边界，验证记录 SHALL 给出实际测试命令、覆盖率和限制
- **AND** SHALL 完成 TypeScript、包边界、构建及受影响回归，不声明未执行的真实 Desktop、模型或平台验证

### Requirement: DSH executable versions are selected by native format validation

Adapter MUST 将单行规范 SemVer `--version` 输出用于选择原生格式尝试，而不是将版本号当作兼容证明。已验证版本列表 MUST 仅包含通过固定 tag 源码审计和真实 CLI 生命周期 Gate 的版本；本变更目标包括 `0.1.5-rc.3` 的 V3 与 `0.1.7-rc.1` 的 V4。未测试的 SemVer 版本可尝试托管 Web，但 MUST 经原生 Remote、历史和流式协议校验才能报告可用；Legacy Host 协议不得恢复。

#### Scenario: Exact supported RC is selected
- **WHEN** `--version` 输出已验证的 `0.1.5-rc.3` 或 `0.1.7-rc.1`
- **THEN** Adapter SHALL 分别选择 V3 或 V4 Modern profile，并按该版本的原生协议完成连接诊断

#### Scenario: Different version is installed
- **WHEN** `--version` 输出其他规范 SemVer，或输出不符合单行规范 SemVer
- **THEN** 规范 SemVer SHALL 进入有界原生协议尝试，格式不兼容时明确失败；非法版本输出 SHALL 在启动 Web 前失败
- **AND** 未经真实版本 Gate 的版本 MUST NOT 被列为“已验证”

