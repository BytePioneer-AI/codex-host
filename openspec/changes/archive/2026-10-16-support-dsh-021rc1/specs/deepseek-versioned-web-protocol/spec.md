## MODIFIED Requirements

### Requirement: DSH executable versions are selected by native format validation

Adapter MUST 只接受单行规范 SemVer `--version` 输出，并以 `0.1.7-rc.1` 为最低版本：低于它的版本 MUST 在启动 Web 前以 `unsupported` 明确失败，提示 MUST 列出已验证版本、说明高于最新已验证版本的版本可以尝试连接但适配度可能有限，并给出升级方式；不低于它的版本 SHALL 使用 V4 profile 尝试托管 Web，且 MUST 经原生 Remote、历史和流式协议校验才能报告可用。版本号不是兼容证明；已验证版本列表 MUST 仅包含通过固定 tag 源码审计和真实 CLI 生命周期 Gate 的版本，当前为 `0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2` 与 `0.2.1-rc.1`。Legacy Host 协议不得恢复。

#### Scenario: Exact supported RC is selected
- **WHEN** `--version` 输出已验证的 `0.1.7-rc.1`、`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2` 或 `0.2.1-rc.1`
- **THEN** Adapter SHALL 选择 V4 profile，并按原生协议完成连接诊断

#### Scenario: Installed DSH is older than the V4 line
- **WHEN** `--version` 输出低于 `0.1.7-rc.1` 的规范 SemVer，包括 `0.1.2`、`0.1.5` 系列及 `0.1.7` 的更早预发布版本
- **THEN** Adapter SHALL 在启动 Web 前返回 `unsupported`，说明最低版本、已验证版本、高于最新已验证版本的版本可以尝试但适配度可能有限，以及升级方式
- **AND** MUST NOT 启动托管 Web、读取 Session 或自动升级 CLI

#### Scenario: Different version is installed
- **WHEN** `--version` 输出不低于 `0.1.7-rc.1` 的其他规范 SemVer，或输出不符合单行规范 SemVer
- **THEN** 规范 SemVer SHALL 进入有界的 V4 原生协议尝试，格式不兼容时明确失败；非法版本输出 SHALL 在启动 Web 前失败
- **AND** 未经真实版本 Gate 的版本 MUST NOT 被列为“已验证”

### Requirement: Journal parsing is strict V4

已验证版本及不低于 `0.1.7-rc.1` 的版本 MUST 严格按 V4 读取日志，包括原生 `developer/message`、Fork 结束原因、来源和 surface 关系，以及 DSH 为未完成工具调用写入的合成结果。V0/V3 header 或事件 MUST 作为协议错误拒绝，Adapter 不再保留 V0/V3 解析路径。所有入口 MUST 有界校验；未知 required 事件 MUST 失败，原生 ignorable 事件 SHALL 仅按 V4 规则处理。非法远端整数 MUST 保持 protocolError，不能归类为可重试 unavailable。

#### Scenario: V4 journal is loaded
- **WHEN** 使用 `0.1.7-rc.1` 至 `0.2.1-rc.1` 中任一已验证版本创建、恢复、导入后打开或分页收到合法 V4 历史或实时事件
- **THEN** Adapter SHALL 验证 V4 header、已知事件、来源/替换关系和原生 Fork closers，并只向公共 Harness 输出可表示的内容
- **AND** 系统与开发者指令 MUST NOT 被伪装成用户输入或 Assistant 回答

#### Scenario: DSH 0.2.1 writes additional log-only records
- **WHEN** 日志含 job 登记与结束（`job/registered`、`job/settled`）、`working-directory/change`、带 `reasoningEffort` 的标题请求、带 `meta` 的 PTC 子调用结果，或 mode 为 `external` 的 v2 子代理目录项
- **THEN** Adapter SHALL 在历史与实时中按其精确形状接受，不生成新 Item，所在回合照常结束
- **AND** 字段缺失、类型或枚举不符的同类记录 MUST 仍报协议错误

#### Scenario: DSH records recovery results for unfinished tool calls
- **WHEN** step 失败、崩溃恢复或 Fork 种子使 DSH 为未完成的工具调用写入合成 `tool/result`：未启动的调用错误为 `ToolNotStartedError`/`TOOL_NOT_STARTED`、无 `sourceEventSeqs`、内容为一个文本块，id 为 `forked-tool-result-<callId>-<该事件 seq>` 或 `interrupted-tool-result-<callId>-<整数>`；已启动的调用错误码为 `TOOL_OUTCOME_UNKNOWN`，`sourceEventSeqs` 指向其 `tool/call`
- **THEN** Adapter SHALL 在历史校验、冷历史和实时事件中接受这些结果，并将对应工具项投影为失败，实时与冷历史的 Item 身份 SHALL 一致
- **AND** 不符合上述形状的未匹配 `tool/result` MUST 仍报协议错误

#### Scenario: Pre-V4 journal or broken references are received
- **WHEN** header 或已知事件是 V0/V3 格式，或替换和来源引用不合法
- **THEN** Adapter SHALL 明确报协议错误，不静默回退或伪造历史

#### Scenario: A remote integer is malformed
- **WHEN** chunk 索引或失败诊断中本应为整数的字段非法
- **THEN** Adapter SHALL 返回 protocolError，且不因此重新打开 journal

### Requirement: Session operations use exact V4 checkpoints

已验证版本 MUST 支持原生创建、恢复、显式导入、Fork 和最后回合回滚。Checkpoint MUST 使用 `v4-turn-end:` 格式并包含精确版本 locator；V0/V3 checkpoint、迁移前的 seq 或其他版本的 locator MUST NOT 被当成有效切点。Session 引用在无 locator 或 locator 为合法 SemVer 时 SHALL 尝试恢复，由 DSH 原生迁移与 V4 校验决定成败。Fork MUST 验证原生继承前缀及 V4 的 marker/closer；子 Session 的继承待办只有在来源可确认且原生清理读回成功后才能接纳。

#### Scenario: Pre-V4 or foreign-version checkpoint is supplied
- **WHEN** Fork 请求携带 `turn-end:`、`v3-turn-end:` checkpoint，或 checkpoint locator 与当前 CLI 版本不一致
- **THEN** Adapter SHALL 在 mutation 前拒绝，不使用迁移前或其他版本的 seq
- **AND** 最后回合回滚 SHALL 只从当前 V4 历史重新计算切点，不接受调用方提供的 checkpoint

#### Scenario: A Thread created under an older DSH is reopened
- **WHEN** 已映射 Thread 的引用无 locator 或带 V3 时期的版本 locator，且当前 CLI 已由 DSH 把该 Session 迁移为 V4
- **THEN** Adapter SHALL 按 V4 读取并继续同一 Native Session，不自行迁移或改写原生存储

#### Scenario: Native session is imported and reopened
- **WHEN** 任一已验证版本解析候选并建立映射后打开
- **THEN** Adapter SHALL 从官方 Remote 读取 V4 原生历史，继续相同 Session ID，不复制或改写原生存储

#### Scenario: Session list reports a stored format status
- **WHEN** 会话列表的行带 `formatStatus` 为 `current` 或 `migration-required`
- **THEN** Adapter SHALL 照常判定导入候选，不因该字段排除会话，也不把它暴露为导入元数据
- **AND** 其他取值 MUST 使会话列表按协议错误失败

#### Scenario: A V4 Fork closes an active source turn
- **WHEN** V4 原生 Fork 在开放回合边界生成 child-owned marker、synthetic closers 或继承待办
- **THEN** Adapter SHALL 按 V4 规则验证继承前缀及 child-owned 尾部，确认待办和持久化状态后才接纳子会话
- **AND** 源会话 MUST 保持不变；验证失败 MUST 明确拒绝接纳
