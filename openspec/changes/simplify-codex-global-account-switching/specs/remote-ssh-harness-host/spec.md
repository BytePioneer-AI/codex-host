## ADDED Requirements

### Requirement: SSH Hosts SHALL expose native single-Account Codex operation

SSH / Unix 远程 Host SHALL 使用远程共享原生 `CODEX_HOME` 中的当前 Codex 身份，保留身份与额度查看，但显式禁用账号库的创建、重新登录、删除和全局切换操作。限制 SHALL 由 Host 服务端能力决定并在 Renderer 体现，不能只隐藏按钮或按操作系统猜测。原有一个共享官方监听器、多客户端及远程凭据不传客户端的要求 SHALL 保持。

#### Scenario: A user opens Account settings for an SSH Host

- **WHEN** Renderer 连接 SSH Host 并读取账号能力
- **THEN** 显示远程原生身份与可读取额度
- **AND** 不显示可操作的添加、切换或账号库删除入口
- **AND** 不把本地保存账号展示为可用于远程的账号

#### Scenario: A stale client calls a remote Account mutation directly

- **WHEN** SSH Host 收到账号库 create、switch、delete 或托管重新登录请求
- **THEN** 在创建条目、写凭据或重启监听器前返回明确 unsupported
- **AND** 不复制造成第二个账号条目，不启动第二个官方后台

#### Scenario: Native remote authentication requires attention

- **WHEN** SSH 原生 Codex 未登录或认证已失效
- **THEN** Host 如实显示需通过远程原生方式处理认证
- **AND** 不导入本机凭据，也不伪造可用账号或额度

### Requirement: Account management policy SHALL distinguish SSH from local shared connections

账号能力 SHALL 来自明确 Host 部署模式。Windows 本地 Desktop / Remote Control 共享连接 MUST NOT 被等同于 SSH Host；Linux/macOS 本地 Host MUST NOT 因平台名称而被禁用本地全局切换。同一共享官方所有者内的客户端 SHALL 获得一致的账号能力与状态。

#### Scenario: Windows Remote Control attaches to a local Desktop Host

- **WHEN** Remote Control 客户端连接支持账号管理的 Windows 本地 Host
- **THEN** 它与 Desktop 共享同一个当前账号、全局 busy gate 和切换事务
- **AND** 客户端不能独立选择账号后台或影响不属于该 Host 的 SSH 身份

#### Scenario: Linux Desktop uses a local Host

- **WHEN** Linux 或 macOS 的本地 Host 已满足安全切换支持条件
- **THEN** 它提供本地全局账号切换能力
- **AND** 不因系统是 Unix 而套用 SSH 单账号管理限制
