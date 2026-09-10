## ADDED Requirements

### Requirement: Legacy layouts SHALL be inventoried before migration

启用新 Codex 运行路径前，Host SHALL 识别旧账号元数据版本、所有旧 home、Thread 绑定、认证存储、原生历史与附加数据库，以及影响恢复的配置差异。共享 home SHALL 优先保留原生目录，不能仅根据 activeAccountId 选择唯一历史源。迁移清单 MUST NOT 暴露凭据或对话正文。

#### Scenario: The selected Account differs from the original home owner

- **GIVEN** 旧 activeAccountId 指向 B，而原生 home 和 B home 都有数据
- **WHEN** 生成迁移计划
- **THEN** 两份数据都被盘点，原生 home 优先作为共享目录
- **AND** B 的当前选择意图与共享目录选择分别处理

#### Scenario: An added Account has no history

- **WHEN** 非原生 home 经核对没有 Thread 或附加历史数据
- **THEN** 只导入其凭据与元数据，不搬动原生历史
- **AND** 不为维持该空 home 启动后台或保留账号路由

### Requirement: Migration SHALL preserve consistent private originals

迁移 SHALL 在确认所有旧官方写入者停止后操作，并保留源目录与恢复记录。SQLite 备份 SHALL 使用一致性机制或确认完整关闭的快照，包含必要 WAL 状态；MUST NOT 只复制活跃 `.sqlite` 主文件。秘密备份 SHALL 继承凭据私有保护。此变更 MUST NOT 自动删除旧账号 home。

#### Scenario: A legacy backend is still writing

- **WHEN** 无法确认旧官方后台停止或数据一致性
- **THEN** 迁移在修改目标前阻断并报告原因
- **AND** 不把不完整主文件复制当作成功备份

#### Scenario: Migration completes successfully

- **WHEN** v2 提交完成
- **THEN** 旧 home 与必要恢复资料仍保留且秘密受保护
- **AND** 它们不再是正常运行的账号后台目录

### Requirement: Supported Thread migration SHALL preserve native identity and required data

受支持历史迁移 SHALL 保留原 Thread ID、内容、归档状态及恢复必需的路径和元数据，并通过官方读取／恢复验证。legacy 与 paginated 历史 SHALL 分别覆盖；项目、分组、关系、附件、动态工具、记忆和其他附加数据 SHALL 分类核对。Host MUST NOT 将多份原生数据库简单覆盖合并或创建第二份聊天事实源。

#### Scenario: Two homes contain distinct ordinary and paginated Threads

- **WHEN** 受支持迁移把它们归入共享 home
- **THEN** 官方列表可以发现两者，恢复时保持原 ID 和既有上下文
- **AND** 下一轮使用全局当前账号，而不是查询旧绑定

#### Scenario: A Thread is archived or has external attachments

- **WHEN** 该 Thread 被纳入支持的迁移范围
- **THEN** 验证归档状态与必要附件可达性，而不只验证 rollout 文件存在
- **AND** 不能把附加数据缺失报告为完整迁移成功

### Requirement: Ambiguous or unsupported migration SHALL fail without data loss

迁移 SHALL 以稳定 Thread ID 和内容核对幂等性。同 ID 同内容可跳过，同 ID 不同内容、未知 schema、无法保留的附加状态或未解决配置差异 SHALL 产生可操作的阻断清单。未通过验证 MUST NOT 提交新布局、删除源数据、重编号 Thread 掩盖冲突或启动旧多后台 fallback。

#### Scenario: Two homes contain conflicting versions of one Thread

- **WHEN** 扫描得到同 ID 但不同内容的记录
- **THEN** 保留两份原件并明确要求解决冲突
- **AND** 不覆盖任一版本，不创建新 ID 假装无冲突

#### Scenario: An unsupported native database contains required state

- **WHEN** 当前迁移器无法证明该状态可被完整恢复
- **THEN** 不提交迁移成功且不接受新的 Codex 工作
- **AND** 提供阻断信息并保持其他 Harness 服务可用

### Requirement: Layout commit and recovery SHALL be idempotent and explicit

v2 元数据和完成标记 SHALL 仅在逐 Thread、认证和必要元数据验证后原子提交；单一文件数或 DB 行数不能代替完整性检查。中断重试 SHALL 识别已完成步骤，不重复导入。v2 已接收新工作或刷新凭据后 MUST NOT 自动整体恢复旧 home 覆盖新数据。

#### Scenario: The process exits during import

- **WHEN** 用户再次启动迁移
- **THEN** 根据持久化记录核对已有目标内容并继续或安全撤销未提交步骤
- **AND** 不重复账号／Thread，不删除迁移后被外部修改的文件

#### Scenario: The user requests downgrade after new work

- **WHEN** v2 已产生新对话或原生 Token 刷新
- **THEN** 系统明确要求前向修复或受验证的回迁路径
- **AND** 不自动覆盖为旧目录／旧 Refresh Token 快照

### Requirement: The completed implementation SHALL remove multi-backend Account routing

变更完成 SHALL 删除 `CodexRuntimePool`、`AccountOfficialListeners`、正常运行的 `ThreadAccountStore`、跨账号历史发现与官方列表扇出、per-draft Account 注入、固定 Thread Account 用量路由及其公共出口。旧格式读取 SHALL 仅存在于迁移边界；MUST NOT 用兼容开关保留第二套可运行账号架构。必要的官方协议、单源官方／外部列表合并和外部 Harness Mapping Store SHALL 保留。

#### Scenario: A migrated installation starts and lists Threads

- **WHEN** 新实现启动、分页、恢复或 Fork 官方 Thread
- **THEN** 只访问共享官方后台，不加载或写入旧 Thread→Account 绑定
- **AND** 账号数量不增加后台数量或官方列表请求源数量

#### Scenario: A stale official multi-Account cursor is supplied

- **WHEN** 客户端携带旧 `codexhost:official-accounts:v1:` 游标
- **THEN** 明确使该游标失效并引导重新读取第一页
- **AND** 不复活旧账号扇出或静默漏掉部分历史

#### Scenario: Final cleanup is reviewed

- **WHEN** 实现进入完成验收
- **THEN** 生产模块、出口、Renderer/CDP 注入、fixtures、测试和文档均已删除或改写旧多后台语义
- **AND** 只在一次性迁移 reader、安全拒绝旧协议及明确的迁移测试中保留必要旧格式引用
