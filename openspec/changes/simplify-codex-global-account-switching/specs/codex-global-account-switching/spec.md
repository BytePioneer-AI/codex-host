## ADDED Requirements

### Requirement: Codex SHALL have one globally selected Account per Host

每个支持账号管理的 Host SHALL 使用一个共享 `CODEX_HOME` 和最多一个存活的官方 Codex 后台；同一官方所有者下的所有 Desktop 连接 SHALL 使用该后台。保存多个账号 MUST NOT 建立多个后台或将 Thread 固定绑定账号。切换 SHALL 影响该 Host 所有官方 Thread 的后续请求，不改变 Harness 归属、不影响其他 Host。

#### Scenario: Two existing Threads continue under the newly selected Account

- **GIVEN** 同一 Host 的两个 Codex Thread 先前使用账号 A
- **WHEN** 全局切换到 B 成功，用户分别继续两个 Thread
- **THEN** 两者的后续请求都使用 B，原 Thread ID 和历史保留
- **AND** 不创建按账号的新 Thread 或持久化 Thread→Account 绑定

#### Scenario: Local and SSH Hosts are open together

- **WHEN** 本地 Host 成功切换当前账号
- **THEN** SSH Host 的认证与 Thread 不变
- **AND** 其他 Harness 的选择与原生认证不变

### Requirement: Account changes SHALL serialize with all official work admission

Host SHALL 在所有官方客户端共享的所有者上原子关闭新工作准入并检查 busy。活跃或在途 Turn、提交请求、命令／工具、审批／问题、实时会话、压缩、认证、非幂等请求及能继续启动 Codex 工作的原生队列／自动继续 SHALL 纳入判定。Host MUST NOT 通过强制取消、盲目重放或隐藏排队完成用户的账号切换。

#### Scenario: Another window is submitting a Turn

- **GIVEN** 窗口 A 的官方 `turn/start` 已准入但尚未收到响应
- **WHEN** 窗口 B 请求切换账号
- **THEN** 返回明确 busy，账号与凭据不变
- **AND** 不停止后台，不取消窗口 A 的工作

#### Scenario: A Codex request races with switching

- **WHEN** 一个 Codex 工作请求与账号切换同时进入同一所有者
- **THEN** 要么工作先准入并使切换返回 busy，要么切换先取得 gate 并使工作明确返回 changing
- **AND** 工作不能被偷偷延后到新身份下执行

#### Scenario: An external Harness is running without active Codex work

- **GIVEN** Claude Code 或 Pi 正在运行，而所有官方 Codex 工作空闲
- **WHEN** 用户切换 Codex 账号
- **THEN** 外部 Harness 的运行本身不使切换返回 busy
- **AND** 已经存在的 Codex 工作依赖或向 Codex 提交中的委派仍计入官方 busy

### Requirement: Successful switching SHALL require old process exit and verified replacement

切换 SHALL 顺序执行停止旧官方后台、确认真实退出、保存最新源凭据、安装目标凭据、启动唯一替代后台、初始化协议及确认目标身份。后台死亡或连接销毁的表象 MUST NOT 代替真实退出；仅登录接口成功、邮箱出现或旧会话能回答 MUST NOT 作为切换已生效的充分证据。成功提交前 SHALL 保持工作 gate 关闭。

#### Scenario: The old model WebSocket retains the previous identity

- **GIVEN** A 的后台具有已建立的模型连接
- **WHEN** 请求切换到 B
- **THEN** 切换流程不依赖原后台的热登录来复用该连接
- **AND** 新后台以 B 的已核对凭据初始化后才报告成功

#### Scenario: Old process exit cannot be confirmed

- **WHEN** 停止操作无法确认旧官方后台已退出
- **THEN** 不安装目标凭据，不启动竞争后台
- **AND** 返回明确故障并只限制 Codex 工作

#### Scenario: The requested Account is already current

- **GIVEN** 当前后台已就绪且身份确认是 A
- **WHEN** 再次请求切换到 A
- **THEN** 返回幂等成功，不重启后台、不改写凭据

### Requirement: Controlled Codex replacement SHALL preserve Desktop and external Harness lifetimes

官方后台的受控停止、启动或回滚失败 MUST NOT 关闭 Desktop 传输、Host、其他 Harness Session、外部 Mapping Store 或委派服务。切换 SHALL 只暂时影响 Codex 请求；失败状态 SHALL 允许用户恢复 Codex 而不要求先结束其他 Harness。

#### Scenario: An external Turn and approval survive switching

- **GIVEN** 一个外部 Harness 正在流式输出或等待真实工具审批
- **WHEN** Codex 后台被受控替换
- **THEN** Desktop 与 Host 进程、外部 Session 和 Native Session 保持运行
- **AND** 流式输出、审批应答、取消及持久化继续正常
- **AND** 不执行 Host 全局 finally 清理

#### Scenario: Both replacement and rollback fail

- **WHEN** 目标后台失败且源账号恢复也失败
- **THEN** 只有 Codex 进入 unavailable，UI 不显示切换成功
- **AND** 外部 Harness 仍可继续现有任务并处理请求

### Requirement: Official reconnection SHALL preserve protocol and Thread continuity

Host SHALL 对新官方连接重新初始化并隔离连接代次，保持 Desktop 端原有初始化会话。已加载 Thread SHALL 通过原生恢复／订阅以原 ID 按需重新连接，不重写历史、不重复已完成 Turn。旧代次的输出、回调、请求响应和缓存更新 MUST NOT 进入新代次；非幂等请求 MUST NOT 自动重放。

#### Scenario: An existing Thread resumes after restart

- **WHEN** 切换后第一次向原 Codex Thread 发起请求
- **THEN** Host 先完成该 Thread 所需的原生恢复，再执行新请求
- **AND** 不新建 Thread、不重复旧 Turn、不向 Desktop 发送第二个 initialize 响应

#### Scenario: A late approval response belongs to the retired connection

- **WHEN** 旧代次的服务器请求响应或输出在新后台启动后到达
- **THEN** Host 丢弃或明确拒绝旧响应，不转发到新后台
- **AND** 旧账号的状态与额度不能覆盖新账号数据

#### Scenario: Two clients resume the same Thread after switching

- **WHEN** 两个 Desktop 连接恢复同一个 Thread
- **THEN** 两者连接同一官方后台，由原生机制共享 loaded Thread
- **AND** 不创建竞争写入者或把恢复转换成 Fork

### Requirement: Account UI SHALL express one Host-wide current identity

账号设置与 Codex Composer 的账号入口 SHALL 调用同一个全局切换操作，明确说明作用范围和跨账号继续使用已有上下文的含义。界面 SHALL 区分 ready、changing、unavailable，只有确认成功才更新成功状态。已存在 Codex Thread 的 Harness 锁定 MUST NOT 被误用为禁止账号切换；不同 Host 的状态 SHALL 隔离。

#### Scenario: Switching from an existing conversation

- **WHEN** 用户在已绑定 Codex Harness 的会话里选择另一个账号
- **THEN** 操作是该 Host 全局账号切换，不更换 Harness
- **AND** 显示全局范围，移除“仅影响新任务／设为默认”的旧含义

#### Scenario: All windows receive a confirmed identity change

- **WHEN** 切换 B 成功并广播 Host 状态修订
- **THEN** 该 Host 的账号页、所有 Codex Composer 和用量浮窗一致显示 B
- **AND** 晚到的 A 读取结果、其他 Host 结果不能覆盖新状态

### Requirement: Account quota reads SHALL follow the OpenCodex multi-credential model

保存账号的额度读取 SHALL 可同时覆盖当前与非当前身份。当前账号 MAY 通过唯一官方后台读取；非当前账号 SHALL 使用严格私有槽位中的凭据直接请求 WHAM，不创建官方进程、不隐式切换共享认证。Host SHALL 为每个账号保留 last-good 持久快照及获取时间，并使用有界并发、超时、per-account single-flight、Token generation／槽位摘要 CAS 和稳定身份复核。普通只读探测不得让切换等待整个账号库；只有源／目标的在途读取需要由发起切换的 UI 协调，OAuth 刷新／写回阶段必须进入 Host gate。刷新失败 MUST NOT 清除或降级已有成功快照。重置卡消费仍 SHALL 只针对当前就绪账号。Thread 累计用量 SHALL 与账号额度分开，不能将跨账号 Thread 用量误称为某个账号账单。

#### Scenario: Refreshing a list containing inactive Accounts

- **WHEN** 用户刷新包含当前 B 与非当前 A 的账号列表
- **THEN** B 通过当前官方身份读取，A 使用其私有槽位直接读取 WHAM
- **AND** 两个结果分别关联稳定本地账号 ID，并带各自获取时间
- **AND** 不切换共享 `auth.json`，不增加官方后台数量

#### Scenario: An inactive quota refresh fails after a previous success

- **GIVEN** A 已有一次成功额度快照
- **WHEN** A 的后续 WHAM 请求发生网络、临时上游或安全写回失败
- **THEN** API 返回 A 的 last-good 快照并标记为 cached
- **AND** 不显示伪造零用量，不把成功快照替换为读取失败

#### Scenario: A stale client consumes an inactive Account reset credit

- **WHEN** 客户端对非当前账号请求重置卡消费
- **THEN** 服务端明确拒绝，而不是按当前账号执行或自动切换

#### Scenario: A Thread has usage from both Accounts

- **WHEN** 原 Thread 在切换后继续产生用量
- **THEN** Thread 原生累计用量不因换账号清零
- **AND** 当前账号配额来自新的已确认身份，不来自旧 Thread 绑定

### Requirement: Legacy per-Thread Account contracts SHALL not remain active

新契约 SHALL 明确提供全局 switch、操作能力和状态，删除账号级 home、默认账号删除回退及固定 Thread Account 的产品语义。旧 `activate`、`__codexhostAccountId` 等路由输入 MUST NOT 被静默解释为新全局切换，也不能继续选择后台；不支持的旧请求 SHALL 得到明确错误。

#### Scenario: An old Renderer submits a draft Account override

- **WHEN** 一个旧客户端提交 per-draft Account 路由参数或旧 activate 操作
- **THEN** Host 明确拒绝为不支持／需要更新，不选择其他后台或全局切换账号
- **AND** 新 Renderer 不再产生该参数或保留 per-draft Account 状态
