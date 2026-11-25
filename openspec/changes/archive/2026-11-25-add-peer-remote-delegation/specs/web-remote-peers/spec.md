## ADDED Requirements

### Requirement: Peer 拓扑变更与探测门控
`codexhost/remote-peers/add`、`update`、`remove` 与 `test` SHALL 仅允许本机已认证会话（`ctx.auth.local === true`）调用；非本机已认证会话调用时 MUST 返回明确的权限错误（`auth/local-required`），不得修改 Peer 配置或发起出站探测。`list`、`reconnect`、`listDirs`、`createDir`、`createWorkspace`、`renameWorkspace`、`deleteWorkspace` SHALL 继续对所有已认证会话开放。

#### Scenario: 本机与非本机调用拓扑管理
- **WHEN** 非本机已认证会话调用 `codexhost/remote-peers/add`、`update`、`remove` 或 `test`
- **THEN** 服务端返回 `auth/local-required` 且不修改持久化配置或不发起出站探测
- **WHEN** 本机已认证会话调用上述方法
- **THEN** 服务端按既有逻辑正常处理

### Requirement: Peer 跨机委派能力门控与端点
Peer manifest SHALL 仅在底层 Host Runtime 确认支持且未通过 `CODEXHOST_DISABLE_PEER_DELEGATION=1` 禁用时声明 `capabilities.delegation: 1`。`POST /api/peer/v1/delegation` SHALL 仅接受固定白名单操作及 1 跳（`hopCount === 1`）请求，并将错误脱敏为客户端安全文案；`/api/ch/v1/rpc` MUST 拒绝调用内部委派通道方法。

#### Scenario: 未声明委派能力的 Peer 或旧版 Runtime
- **WHEN** Peer 未声明 `capabilities.delegation: 1` 或 B 端连接旧版不支持委派的 Host Runtime
- **THEN** 调用方在转发前以 `UNSUPPORTED` 拒绝且不回退到本机

#### Scenario: 超过 1 跳限制的请求
- **WHEN** 节点收到 `hopCount > 1` 或嵌套远端 `hostId` 的 Peer 委派请求
- **THEN** 节点以 `FORBIDDEN` 立即拒绝且不执行任何操作

### Requirement: 本机私有 Peer 委派桥接
运行 Peer Hub 的 Web 实例 SHALL 在数据目录的 `peer-delegation-bridges/` 下写入各自独立的 `0600` 描述文件并在退出时仅清理自身文件，仅在回环地址提供 Bearer Token 鉴权且拒绝任何 `Origin` 头的私有桥接端点。多实例并发共用同一 Host 数据目录时 MUST NOT 互相覆盖或误删。写操作在转发失败时 MUST NOT 自动重试；A 桥收到远端 HTTP 200 `{ ok: false, error }` 信封时 SHALL 独立二次脱敏错误文案与 `details`。

#### Scenario: 桥接鉴权、信息隔离与二次脱敏
- **WHEN** 本机 `host-runtime` 持有效令牌请求 `hosts`
- **THEN** 桥接返回各已启用 Peer 摘要，不包含 Peer Token 或 URL
- **WHEN** 未携带有效 Bearer Token、携带任意 `Origin` 头（含空值），或远端在 HTTP 200 错误信封中携带敏感路径/凭据
- **THEN** 桥接拒绝未授权请求，并对远端错误信封按错误码输出固定安全文案与白名单 `details`
