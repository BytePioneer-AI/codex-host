## ADDED Requirements

### Requirement: Stored Accounts SHALL distinguish users within the same workspace

每个保存账号 SHALL 有独立的本地账号 ID，并关联经原生认证确认的稳定用户身份及工作区。工作区 `account_id`、邮箱或显示名单独 MUST NOT 作为账号去重、凭据写回或恢复的完整依据。相同已确认用户及工作区的重复登录 SHALL 更新原条目，不创建重复已连接账号。

#### Scenario: Two users belong to the same Team

- **GIVEN** 两个账号具有相同工作区 ID，但不同用户身份
- **WHEN** 导入、登录、保存或恢复它们的凭据
- **THEN** 保持两份正确关联的账号记录
- **AND** 不因工作区 ID 相同而把 B 的 Token 写入 A

#### Scenario: A user logs into the same identity again

- **WHEN** 登录完成并确认用户及工作区与已有条目一致
- **THEN** 更新该条目的最新凭据，不增加重复账号

### Requirement: Credential persistence SHALL remain private and atomic

账号元数据、浏览器契约、日志和普通诊断 MUST NOT 包含 Token、完整认证文件或私有凭据路径。秘密快照、临时替换文件和含认证的恢复备份 SHALL 使用用户私有访问控制、原子安装和有界清理。Windows SHALL 验证实际 DACL，不能只依赖 POSIX mode；路径异常、权限不足或不支持的原生存储 MUST fail closed，不能静默降低原生保护。官方共享 `CODEX_HOME` MAY 保留 `CodexSandboxUsers` 的只读／遍历权限及其继承到原生 `auth.json` 的只读 ACE，但 MUST 拒绝该主体的写入、删除、所有权或 DACL 修改权限，并 MUST 拒绝 Everyone、Users、Authenticated Users 等宽泛读取。账号槽位、Journal、备份、writer lock 与进程 witness MUST 位于不继承该 Sandbox ACL 的严格私有目录。

#### Scenario: Windows files inherit broad access permissions

- **WHEN** 目标秘密文件权限允许无关用户读取
- **THEN** Host 在秘密落盘前使用受支持平台原语建立私有权限或拒绝操作
- **AND** 不能将 `mode: 0o600` 返回成功当作已保护的证据

#### Scenario: The configured authentication backend is unsupported

- **WHEN** 原生认证使用尚未验证的 keyring、外部 Token、API Key 或未知存储格式
- **THEN** Host 保留原生正常使用并明确禁用不安全的账号管理能力
- **AND** 不自动改配置、导出秘密或退回明文文件

#### Scenario: A failure is reported to Renderer

- **WHEN** 凭据解析、写入或身份验证失败
- **THEN** Renderer 收到脱敏的错误类别及可操作提示
- **AND** Token 不进入 RPC、诊断、命令行参数或测试快照

### Requirement: OAuth refresh ownership SHALL follow the active credential boundary

当前官方后台 SHALL 继续使用其原生刷新机制维护共享 home 中的当前凭据。Host 的额度子系统 MAY 参照 OpenCodex，为非当前账号的私有槽位执行 OAuth 刷新，但 MUST 使用 per-account single-flight、credential generation／槽位摘要 CAS、稳定身份复核和原子写回。普通 WHAM 读取 MAY 与切换并行，但 OAuth 刷新及槽位写回 MUST 计入账号切换的准入边界；当账号成为当前身份后，Host MUST NOT 与官方后台并发刷新该身份。停止后保存 SHALL 以共享原生存储中的最新有效内容为准，不以首次登录快照覆盖已刷新的 Token。凭据所有权 SHALL 在进程退出和原子切换边界转移。

#### Scenario: Tokens rotate while the current Account is active

- **GIVEN** 官方后台已把 A 的凭据更新为新版本
- **WHEN** 用户切换到 B，之后又切回 A
- **THEN** Host 保存并恢复 A 的最新原生版本
- **AND** 不重新安装已经失效的首次登录 Refresh Token

#### Scenario: An inactive Account quota read rotates its Refresh Token

- **GIVEN** B 当前未激活且额度读取收到可恢复的 401
- **WHEN** Host 刷新 B、重放 WHAM 并获得成功结果
- **THEN** 新 Access Token 与旋转后的 Refresh Token 通过槽位摘要 CAS 原子写回 B
- **AND** 写回前再次确认 JWT 用户及工作区仍属于 B
- **AND** 切换事务不能在该刷新飞行中把旧 B 凭据安装为当前凭据

#### Scenario: An inactive credential changes during refresh

- **WHEN** B 的槽位在额度刷新请求期间被其他受控操作替换
- **THEN** 旧刷新结果不得覆盖新槽位
- **AND** Host 保留已有额度快照并将该次刷新视为未提交，而不是猜测新凭据归属

#### Scenario: The target refreshes before startup verification fails

- **WHEN** B 在目标启动期间更新了自身凭据，但随后的就绪检查失败
- **THEN** Host 停止 B 并保存能确认归属的最新 B 凭据，再恢复 A
- **AND** 回滚不将 B 的更新写进 A，也不倒退 B 的有效快照

### Requirement: Credential changes SHALL recover without exposing mixed identities

切换 SHALL 使用小型无 Token 的持久化阶段记录与受保护快照实现原子性和恢复。当前账号提交 SHALL 发生在新后台身份与就绪确认后。失败 SHALL 尝试恢复源身份；无法确认源或目标时 SHALL 仅使 Codex unavailable。崩溃后 SHALL 在接受官方工作前核对实际原生凭据、记录阶段及已提交身份，不得盲信过时 current 指针。

#### Scenario: A crash occurs after installing B but before committing metadata

- **WHEN** Host 在上述边界重启
- **THEN** 先恢复或完成明确的凭据事务，再允许 Codex 请求
- **AND** 不以旧 A 元数据命名并保存实际 B 的凭据

#### Scenario: Effective storage configuration requires native initialization

- **GIVEN** 冷启动恢复时没有现存后台可读取实际生效配置
- **WHEN** 已取得所有权且受支持版本的初始化已验证不会自动恢复工作
- **THEN** 可在工作准入关闭时初始化唯一后台，仅核对原生配置，不恢复用户 Thread
- **AND** 停止并确认退出后重新核对实际凭据，再执行恢复、正式启动及身份验证
- **AND** 未知原生活动、不支持存储或未确认退出均阻止凭据修改及工作准入，不启动并行诊断后台

#### Scenario: Target authentication is invalid

- **WHEN** B 无法通过原生身份及受认证就绪检查
- **THEN** 不报告切换成功，停止目标后恢复并确认 A
- **AND** 若 A 也恢复失败，返回 rollback-failed 且 Codex unavailable，其他 Harness 不关闭

#### Scenario: A second writer changes credentials during an operation

- **WHEN** 检测到未协调的凭据写入、身份变化或所有权冲突
- **THEN** Host 不覆盖未知新内容或将其归入任一猜测账号
- **AND** 明确停止账号事务并提示恢复处理

### Requirement: Adding an Account SHALL use the sole backend and restore the prior identity

添加账号 SHALL 复用全局独占认证事务：在 Codex 空闲时保存并停止当前身份，在唯一后台发起原生设备代码登录，确认成功后保存新身份，再恢复原当前账号。没有原当前账号时，首次成功登录 SHALL 成为当前账号。Host MUST NOT 为添加账号运行第二个官方／认证后台，MUST NOT 把未完成登录的占位记录计入已连接账号。

#### Scenario: Adding B while A is current

- **WHEN** 用户确认添加账号并成功完成 B 的原生设备代码登录
- **THEN** B 被安全保存，A 恢复为当前就绪账号
- **AND** 添加过程任意时刻最多一个官方后台
- **AND** 其他 Harness 继续运行；Codex 暂停范围在登录前被明确告知

#### Scenario: The first Account is added to a signed-out Host

- **WHEN** 没有可恢复的原账号且登录 B 成功
- **THEN** B 成为唯一当前账号
- **AND** 不创建虚构的默认账号凭据

### Requirement: Login completion and cancellation SHALL be transaction-scoped

登录成功 SHALL 依赖原生完成事件及身份核对，而不是账号列表出现邮箱。取消、超时、失败和重新登录 SHALL 使用同一 gate、停止顺序与恢复逻辑。旧登录的延迟通知或写入 MUST NOT 覆盖已恢复账号。Desktop 原生登录／退出接口 MUST NOT 绕过生命周期所有者直接热改认证。

#### Scenario: The user cancels device authorization

- **WHEN** 添加 B 的设备代码授权被取消或超时
- **THEN** Host 取消并结束登录后台，恢复 A，移除未确认的临时记录
- **AND** 迟到的 B 完成事件不能改变当前账号或增加已连接条目

#### Scenario: An existing email is returned before login completion

- **WHEN** 刷新接口返回已有邮箱但当前登录事务尚未确认成功
- **THEN** UI 不能报告新账号登录成功或复制原账号

#### Scenario: A native Desktop authentication request arrives directly

- **WHEN** Desktop 不经过设置页直接请求登录、取消或退出
- **THEN** 受支持操作进入相同独占认证事务
- **AND** 不支持模式在改写认证前明确拒绝，不直接绕过 gate 转发

### Requirement: Deleting a saved Account SHALL not delete shared history

删除 SHALL 仅影响非当前账号的凭据及账号元数据。当前账号 SHALL 要求先显式切换或完成受控退出登录；Host MUST NOT 隐式回退其他账号。任何账号删除 MUST NOT 删除共享 home、官方 Thread、旧迁移原件或外部 Harness 数据。

#### Scenario: The original native Account is now inactive

- **WHEN** 用户删除其保存账号条目
- **THEN** 删除的是对应凭据与元数据，不是原生共享目录或历史
- **AND** 不保留仅因旧默认目录角色而产生的运行时账号特例

#### Scenario: A client attempts to delete the current Account

- **WHEN** 直接请求删除当前账号
- **THEN** Host 明确拒绝并要求先切换或退出登录
- **AND** 不自动选择另一个账号，也不停止其他 Harness
