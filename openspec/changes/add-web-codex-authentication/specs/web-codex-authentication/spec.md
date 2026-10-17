# Spec Delta

## Purpose

为隔离 Web Codex 提供最小原生认证闭环，使用户能够区分模型目录可读、需要登录与检查失败，并在电脑或手机浏览器完成当前来源的登录；不接管 GUI 认证或建立多账号管理。

## ADDED Requirements

### Requirement: Readiness reflects native authentication requirements

Web Codex SHALL 根据当前 Provider 的原生认证要求判断可用性。缺少所需认证时 MUST 返回 `authenticationRequired`，不得仅凭模型目录返回成功而报告就绪，也不得凭认证文件是否存在推断状态。检查 MUST NOT 创建 Native Session 或发送模型请求；无法确认时 SHALL 显示检查失败。

#### Scenario: Models are available without required authentication
- **WHEN** 模型目录可读，但原生状态表明当前 Provider 要求 OpenAI 认证且没有当前账户
- **THEN** Codex SHALL 显示需要登录，其模型 MUST NOT 作为可执行选择发布
- **AND** 其他可用 Harness 的模型和执行 SHALL 不受影响

#### Scenario: Native API key or another Provider is configured
- **WHEN** 原生状态返回现有 API Key 认证，或当前 Provider 不要求 OpenAI 认证
- **THEN** 系统 SHALL 按实际配置继续检查，不因缺少 ChatGPT 账户而强制登录
- **AND** 可读模型目录 MUST NOT 被描述为已成功完成推理验收

#### Scenario: Account inspection fails
- **WHEN** 原生认证检查超时、退出或返回不兼容结果
- **THEN** 系统 SHALL 显示有界、可重试的检查失败，不猜测为未登录或沿用旧就绪结论

### Requirement: Web exposes one native device-code login flow

Web SHALL 在不依赖当前 Thread 或可用模型的设置入口展示 Web Codex 状态，提供手动检查、ChatGPT 设备码登录及取消本次登录。登录 SHALL 仅由用户显式发起，展示原生返回的验证链接与验证码，并等待原生完成结果；返回验证码本身 MUST NOT 被视为登录成功。

#### Scenario: A signed-out user opens settings on a phone
- **WHEN** Codex 没有可选模型且用户打开 Web 设置
- **THEN** 用户 SHALL 仍能发起登录并在当前设备打开验证链接，无须访问服务端 localhost 回调
- **AND** 该操作 MUST NOT 创建或切换 Thread

#### Scenario: Login completes, fails or expires
- **WHEN** 原生登录给出最终结果
- **THEN** Web SHALL 退出待验证展示并报告成功或具体失败，失败后允许用户明确重试
- **AND** 系统 MUST NOT 自动发起下一次登录或发送原有草稿

#### Scenario: Already authenticated or native login is unsupported
- **WHEN** 当前认证已满足要求，或所用 CLI 不支持设备码登录
- **THEN** 已认证状态 SHALL 不提供账号切换；不支持时 SHALL 明确提示，不自动改用另一种登录方式
- **AND** 既有原生配置 SHALL 保留，不新增 API Key 或 Provider 编辑表单

### Requirement: Login remains owned and quiescent

同一隔离来源 SHALL 由既有唯一 owner 管理至多一次在途登录。登录准入 MUST 与执行准入互斥；有活动 Turn、正在推进的队列、交互、后台任务或未决提交时 SHALL 拒绝登录，不自动取消工作。认证失败后已暂停的队列 SHALL 原位保留，不阻止重新登录。允许登录前 SHALL 确认空闲原生执行资源安全释放；登录期间 MUST NOT 接受新的执行。

#### Scenario: Two browsers request login
- **WHEN** 同一来源已有在途登录，另一浏览器再次请求开始登录
- **THEN** 系统 SHALL 返回同一次登录的当前状态，不创建第二个原生登录
- **AND** 取消 SHALL 核对本次登录身份；过期取消 MUST NOT 影响后来的登录

#### Scenario: Login races with execution
- **WHEN** 首次提交、队列执行或原生命令与登录同时到达
- **THEN** 只有满足准入条件的一方 SHALL 开始，另一方 SHALL 收到明确的忙碌结果
- **AND** 系统 MUST NOT 丢弃输入、清空队列或停止活动工作来让登录继续

#### Scenario: A gateway disconnects or the owner stops
- **WHEN** shared 网关断开但 owner 仍在运行
- **THEN** 登录 SHALL 继续由 owner 管理，重连 SHALL 读取当前状态而非重启登录
- **AND** owner 停止或重启后 MUST NOT 自动恢复失去原生依据的验证码或重放登录

### Requirement: Authentication changes refresh the existing source

登录完成、原生认证更新或用户手动检查后，系统 SHALL 重新读取当前认证并刷新相关模型目录；旧请求不得覆盖更新结果。后续用户提交 SHALL 使用更新后的认证和原有 Native Session 身份。刷新 MUST NOT 改变其他 Harness、当前草稿、用户模型选择或会话归属，也不得引入持续轮询。

#### Scenario: Login succeeds after a failed initial inspection
- **WHEN** 原生确认登录成功且重新检查通过
- **THEN** 已打开的浏览器 SHALL 更新状态和 Codex 模型，无须重启 Web 或后台
- **AND** 旧的未登录结果 MUST NOT 再覆盖新结果

#### Scenario: An existing isolated session continues
- **WHEN** 用户在重新认证后明确提交下一条消息
- **THEN** 系统 SHALL 沿用原有 Thread 与 Native Session 身份继续执行，不替换为新会话
- **AND** 原始失败消息 MUST NOT 被自动重发

### Requirement: Native authentication failures remain actionable

来自原生模型执行的明确认证失败 SHALL 以 `authenticationRequired` 呈现，并使旧就绪结论失效；原 Turn 的失败事实和历史 SHALL 保留。已有待发送队列 SHALL 保留并暂停，登录完成不得自动推进。系统 MUST NOT 自动重试、自动登录或切换执行来源。普通工具输出中的 HTTP 错误不得被误判为 Harness 认证失败。

#### Scenario: Inference returns unauthorized after catalog discovery
- **WHEN** Codex 模型请求返回明确的认证失败
- **THEN** Web SHALL 显示重新登录提示，后续执行不得继续依据旧就绪缓存放行
- **AND** 已排队消息 SHALL 保留并暂停，允许用户重新登录；登录或刷新状态本身 MUST NOT 重发本次请求或推进队列

#### Scenario: A tool reports an unrelated HTTP 401
- **WHEN** Agent 执行的工具访问其他服务得到 401
- **THEN** 系统 SHALL 保留原生工具结果，不因此将 Codex 标为需要登录

### Requirement: Authentication stays inside the configured Web boundary

认证操作 SHALL 仅针对服务端固定的隔离 Web 来源并执行既有访问认证与同源校验。浏览器不得覆盖 home、CLI、插件或原生方法。凭据存储与刷新 MUST 归原生 CLI；Host 不复制、同步或保存 GUI 凭据。验证码仅供已授权客户端临时展示，不写入日志、历史或浏览器持久存储。

#### Scenario: A request targets another home or official GUI authentication
- **WHEN** 请求覆盖来源配置、伪造来源或试图操作 GUI 原生认证
- **THEN** 系统 SHALL 拒绝，不转发至官方路径，也不创建替代执行来源

#### Scenario: An older owner or plugin lacks login support
- **WHEN** 当前 owner 或插件没有本次登录能力
- **THEN** Web SHALL 明确报告不支持，MUST NOT 启动本地第二个 Adapter 或恢复已删除的 GUI 账号方法
- **AND** shared 与显式 standalone 的 home 隔离及唯一所有权 SHALL 保持
