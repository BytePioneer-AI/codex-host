## ADDED Requirements

### Requirement: Shared Host owns the configured isolated Web Codex source

默认shared模式显式启用的一个隔离Web Codex来源 SHALL 由共享Host唯一拥有runtime、nativeRef、恢复metadata与durable presentation journal。Web SHALL 仅作为认证网关和协议投影客户端；shared模式 MUST NOT 本地resume或保存第二份可写会话。existing external AppServerHost及其MappingStore语义 MUST 保持。

#### Scenario: Web and Desktop connect in either order
- **WHEN** Web-only使用隔离Web Codex，或Desktop连接与Web操作按任一顺序/并发使用同Host profile
- **THEN** 所有隔离来源操作 SHALL 到同一后台owner，第二可写composition SHALL 被拒绝
- **AND** Web-only SHALL 不要求Desktop或stock GUI Codex已启动
- **AND** Desktop-only SHALL 不启动未使用的Web Codex，不意味着新增GUI隔离来源入口

#### Scenario: Gateway stops during a Turn
- **WHEN** Web gateway断线或停止而后台仍运行
- **THEN** 隔离Turn SHALL 继续由后台拥有，重连 SHALL 读取权威snapshot而非本地resume
- **AND** Web Push SHALL 不被承诺在gateway关闭后仍送达

### Requirement: Native GUI Codex remains outside isolated execution routes

Host MUST 在全部read/write/interaction入口校验服务端配置的来源地址与能力，不允许请求覆盖home、Adapter或nativeRef。Web Codex SHALL 保留现有canonical home隔离及locator匹配；GUI native Codex MUST 保留official route，MUST NOT 作为external或隔离可执行地址被接管。一个后台 SHALL 只支持本变更显式配置的单个Web Codex home，不提供多home产品注册。

#### Scenario: Request for another source is forged
- **WHEN** 请求伪造GUI native ID、未知scope、跨来源resume/import/fork或指定另一home
- **THEN** Host SHALL 拒绝操作，MUST NOT fallback official、本地owner或新建来源

#### Scenario: A late client carries conflicting configuration
- **WHEN** 已运行后台收到不同Web Codex配置，或home与GUI home存在相等/父子/符号链接后的重叠
- **THEN** 配置 SHALL 被拒绝，既有owner SHALL 不被替换

### Requirement: Owner lifecycle preserves confirmed native facts

客户端通道 SHALL 复用现有epoch/cursor失效通知与snapshot恢复，不新增平行event系统。写命令结果未知时 MUST NOT 自动重发；native release未确认时 MUST NOT 创建第二session。后台重启 MUST 先有旧受监管进程树退出证明，再恢复已有metadata/nativeRef/journal并结算未闭合Turn；MUST NOT 凭文件重建内存queue或保证中断任务继续。

#### Scenario: Accepted input loses its reply
- **WHEN** prompt可能已接受但连接断开，且现有事实无法证明提交结果
- **THEN** 客户端 SHALL 核对权威状态并明确保留未知结果，MUST NOT 自动retry或跨来源提交

#### Scenario: Idle close fails or Host crashes
- **WHEN** native关闭未确认，或后台崩溃且旧native树尚未确认退出
- **THEN** 后续resume SHALL 被阻止，直到满足退出/恢复准入
- **AND** 重启后 SHALL 不重发prompt或恢复不存在的内存queue

### Requirement: Only Web-owned organization data changes owner

明确Web自建workspace定义及隔离local会话归属/pin/archive SHALL 随隔离来源由Host持久化并按来源投影。mixed workspaces文件中的external归属/pin/archive与自动/legacy reference rows MUST NOT 作为该来源权威迁入；自建workspace中的external引用 SHALL 排除并报告，MUST NOT 当作隔离来源悬引用阻止迁移。官方projects SHALL 继续只读；external既有项目补充与Desktop官方pin通路 SHALL 保持，MUST NOT 复制为第二权威。local pin MUST NOT 冒充官方pin成功；草稿/UI状态、队列持久化、Codex用量存储不属于该迁移。

#### Scenario: Web-only changes a local pin
- **WHEN** Desktop不在线且用户修改隔离来源local pin/archive/workspace
- **THEN** Host SHALL 保存并在重连/重启后恢复该来源值
- **AND** 官方pin写入不可用 SHALL 不阻止正常会话执行，MUST NOT 报告官方GUI分区已更新

### Requirement: One explicit source migrates only after verified quiescence

迁移 SHALL 只处理一个显式源，并确认无active turn、queue、interaction及in-flight submission/upload以及旧writer/native实例已退出。legacy源 SHALL 在退出前核实静默；无状态接口时 SHALL 要求用户明确确认处理完活动后正常退出。MUST NOT 用mtime、PID扫描、marker或shutdown后的文件推断原内存活动已清空。

#### Scenario: A source has queued or unresolved work
- **WHEN** 源仍有queue、审批、未决提交或上传
- **THEN** 迁移 SHALL 延后，MUST NOT 取消或重启来消除这些状态，MUST NOT 重发prompt

### Requirement: Migration preserves the complete existing recovery format

Host SHALL 严格验证并迁移index、events、projections及Web自有组织数据，保持nativeRef、home、cwd、backfill、checkpoints、children、业务ID和event seq。未知schema、损坏行/断seq、悬引用、源变化或目标/ID冲突 SHALL 阻止发布并保留源；MUST NOT fallback空数据、自动alias/改ID或native去重。原home及历史附件路径 SHALL 原位保留，不迁凭据或附件字节，不进行GC；debug harness.jsonl SHALL 仅留源备份。

#### Scenario: Source or target cannot be validated
- **WHEN** 源存在未知格式、坏journal行、关联缺失，或目标存在冲突身份
- **THEN** 迁移 SHALL 失败而不改变源或启动新执行，MUST NOT 静默跳过数据/自动改ID

#### Scenario: A valid idle source commits
- **WHEN** 完整源集合验证成功并在唯一owner锁下完成staging
- **THEN** Host SHALL 原子发布commit记录后切换路由，commit前源、commit后目标 SHALL 分别是唯一权威
- **AND** native home及历史附件绝对路径 SHALL 不因Host data root变化而改变

### Requirement: Compatibility and rollback cannot create a second writer

shared Host与explicit standalone SHALL 复用同一隔离session实现，仅composition/profile不同；MUST NOT 并发写相同root/home或因shared离线自动fallback standalone。旧协议/schema不支持写入时 SHALL 拒绝。回滚 SHALL 先停止新owner并确认native退出；仅目标未产生新mutation时允许恢复源，有新写入时 MUST 拒绝自动回退旧副本。

#### Scenario: Commit is interrupted or rollback is requested
- **WHEN** 发布前后崩溃或目标产生新mutation后请求自动回滚
- **THEN** 系统 SHALL 根据commit记录选择唯一权威，不双写；新mutation后的自动回滚 SHALL 被拒绝

#### Scenario: An old or offline client requests local fallback
- **WHEN** Host不支持隔离来源能力或shared服务离线
- **THEN** 客户端 SHALL 明确报告不可用并只重连同profile，MUST NOT 启动第二本地执行来源

### Requirement: Implementation retains package boundaries and reports actual validation

Host MUST 通过公共exports加载抽取的session owner及安装插件契约，不导入web-server应用代码或具体Adapter。抽取 SHALL 沿用现有实际类型/窄操作，不增加通用命令总线、owner registry或第二套event/revision系统。完成时 SHALL 更新当前行为文档并执行受影响定向验证及boundary checker，真实native验证和未验证项 SHALL 分开报告。

#### Scenario: Change is delivered
- **WHEN** 实现本change并准备交付
- **THEN** shared本地执行重复路径 SHALL 被移除，standalone SHALL 使用同一实现
- **AND** 文档与实际能力/验证结果 SHALL 一致，不以spec提案存在宣称功能已实现
