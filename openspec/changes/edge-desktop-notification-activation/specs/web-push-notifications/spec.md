## ADDED Requirements

### Requirement: 本机 Edge 通知可以激活运行中的原生客户端

系统 SHALL 保留 Edge 的 Web Push 订阅和通知展示，并允许本机通知点击通过认证 RPC 将 sessionId 交给运行中的 CodexHost 原生壳。原生壳未运行或明确未接管激活时 SHALL 使用既有 Web 点击回退。

#### Scenario: 本机 Edge 点击且原生壳运行

- **GIVEN** 当前订阅属于请求 credential，请求为直连 loopback，且原生壳 ready 记录对应进程存活
- **WHEN** 用户点击带 sessionId 的 Edge 通知
- **THEN** Service Worker SHALL 请求原生激活且不得调用 `clients.openWindow`
- **AND** Web 服务 SHALL 以固定 argv 调用 `codexhost app --session <id>`
- **AND** 原生壳 SHALL 显示窗口并打开目标会话

#### Scenario: 原生壳未运行或明确未接管

- **WHEN** 原生壳 ready 记录不存在、进程已退出或 Launcher 可确认原生壳未接管激活
- **THEN** 激活 RPC SHALL 返回 `activated: false`
- **AND** Service Worker SHALL 保持既有 Web client 与 openWindow 回退

#### Scenario: 激活结果未知

- **WHEN** 单实例请求可能已入队但回执丢失，或 HTTP 响应在激活后丢失
- **THEN** Service Worker SHALL 使用同一 requestId 有限重试且 Web 服务不得重复调用 Launcher
- **AND** 未知的原生激活结果 SHALL NOT 被保存或返回为确定成功
- **AND** 结果仍未知时 SHALL NOT 打开 Web 回退，避免原生客户端与浏览器双开

#### Scenario: ready 记录不完整

- **WHEN** ready 记录缺少启动时间、可执行文件或版本，即使其中 PID 恰好存活
- **THEN** Web 服务 SHALL 拒绝原生激活且不得调用 Launcher

#### Scenario: 远程或不匹配的订阅

- **WHEN** 请求为 relay/非 loopback、缺少本机认证或 endpoint 不属于当前 credential
- **THEN** Web 服务 SHALL NOT 启动或激活原生程序
- **AND** 通知点击 SHALL 保持该设备原有的 Web 行为

### Requirement: 原生壳不得替换 Edge 通知来源

原生壳中的通知设置 SHALL 引导用户在 Edge 管理订阅，不得新建或自动续订 WebView2 PushSubscription。已有 WebView2 订阅 SHALL 被退订，Edge 订阅及其通知标题、正文、图标和系统展示 SHALL 保持不变。

#### Scenario: 在原生壳打开通知设置

- **WHEN** 用户在原生壳查看或操作通知设置
- **THEN** UI SHALL 提供到 Edge 管理通知的入口
- **AND** 不得注册或恢复 WebView2 推送订阅

#### Scenario: 服务端退订失败

- **WHEN** 原生壳清理旧订阅时服务端退订请求失败
- **THEN** 本地 unsubscribe 和 Service Worker unregister SHALL 继续执行
- **AND** 旧 worker 不得继续续订或展示 WebView2 通知

### Requirement: 会话激活复用单实例和待导航状态

Launcher 与原生壳 SHALL 通过现有单实例通道传递有界 sessionId。已有窗口、冷启动和 Web 重连 SHALL 共用同一个会话目标语义，不得允许激活参数选择其他程序、URL 或数据目录。

#### Scenario: 原生壳已就绪

- **WHEN** 单实例通道收到 ShowSession
- **THEN** 原生壳 SHALL 恢复并聚焦窗口
- **AND** live 页面 SHALL 优先使用现有页面内会话导航与 Cookie

#### Scenario: 原生壳或 Web 尚未就绪

- **WHEN** 会话激活先于单实例或 Web ready 到达
- **THEN** 系统 SHALL 保存唯一的待处理会话目标
- **AND** Web ready 后 SHALL 使用当次可信 login URL 打开该会话
