## ADDED Requirements

### Requirement: 通过已配对 Peer 通道发现远端主机与工作区
系统 SHALL 提供 `codexhost host list`（及控制路由 `/v1/host/list`、MCP `host_list`）列出已启用的配对 Peer 主机摘要，包含 `hostId`、展示名称、在线状态、委派能力与已知工作区路径。摘要 MUST NOT 暴露 Peer 访问令牌或原始 Origin URL。

#### Scenario: 发现远端 Peer 主机
- **WHEN** 调用方在 A 机执行 `codexhost host list` 或 MCP `host_list`
- **THEN** 系统返回已配对 Peer 的主机摘要与工作区路径，且不包含任何访问令牌或原始 URL

### Requirement: 通过已配对 Peer 通道执行跨机委派与会话控制
对于 `remote-peer:<peerId>` 主机，CLI、控制服务与 MCP SHALL 支持 `--host <hostId>` 及 `thread://<id>?hostId=<encoded-host-id>` 执行 `read`、`wait`、`send`（含 `steer`/`interrupt`）、`cancel`、`answer`、`delegate start`、`thread list`、`harness list` 与 `harness inspect`。远端 `delegate start` 的 `worktree`/`base` SHALL 在目标机 B 本地创建并参与 `requestId` 幂等去重；`wait` SHALL 在 A 端按单调总期限约束分段轮询远端 `read`。所有返回链接与下一步命令提示 SHALL 保留 `thread://<id>?hostId=<encoded-host-id>`，远端失败 MUST NOT 回退到本机，且 `callerThreadId` MUST NOT 转发到远端。

#### Scenario: 远端委派与 worktree 幂等重放
- **WHEN** 调用方对 `remote-peer:<peerId>` 执行带 `--worktree` 与 `--request-id` 的 `delegate start`，并重复提交相同请求
- **THEN** B 机在本地创建 worktree 并启动目标 Thread，重放返回同一 Thread 与 worktree 信息且不创建重复分支
- **AND** 返回的 `deepLink`、compact `thread` 链接与 `next` 提示均包含 `thread://<id>?hostId=<encoded-host-id>`

#### Scenario: 跨机 `thread wait` 受总期限约束
- **WHEN** 调用方对 `remote-peer:<peerId>` 上的运行中 Thread 执行有界 `thread wait`
- **THEN** A 端按剩余预算约束单次远端读取并分段轮询，直到终态、出现待回答问题或总期限到期返回 `timedOut: true`

### Requirement: 跨机委派的一跳防环路限制
本机委派层级继续不受深度限制；跨机 Peer 委派 SHALL 严格限制为 1 跳（`hopCount === 1`）。该限制运行在同 OS 用户（同 UID）信任边界内，作为协作式委派调用路径的防递归护栏（非针对同 UID 全权限 Shell 的 OS 沙箱）：外部 Harness 使用每 Thread HMAC 绑定令牌；原生 Codex 因官方 `app-server` 共进程且无每 Thread 环境注入，使用仅限活跃原生 Codex Thread 的共享令牌并配合持久化祖先链；祖先链查询异常或超深 MUST fail-closed 拒绝，且远端来源 Thread 创建本机子 Thread 时不得以普通 `parentThreadId` 洗白来源。

#### Scenario: 远端发起会话及重启后子线程被阻止再次跨机
- **WHEN** B 机上由远端 Peer 委派创建的 Thread（包含首轮、重启续聊、以及尝试指定普通父 Thread 的本机子 Thread）尝试发起指向任意远端主机的委派或读取
- **THEN** B 机以 `FORBIDDEN` 拒绝该请求，防止 `A -> B -> A` 或 `A -> B -> C` 环路

#### Scenario: 伪造、跨类型冒充或无法确认祖先链时 fail-closed 拒绝
- **WHEN** 共享令牌冒充外部 Harness 活跃 Thread、绑定令牌试图伪造其他 `callerThreadId`，或持久化祖先链查询出错/超过最大深度
- **THEN** 控制层以 `FORBIDDEN` 拒绝该远端操作

### Requirement: 跨机观测边界与 Codex Desktop 只读兼容
第 1 阶段跨机 `thread watch`、`thread export`、`thread file` 及远端 `start`/`send` 的 `--watch true` MUST 在访问本机 Thread 前以明确错误拒绝（不降级为裸本机 ID）。`remote-ssh*` 与 `remote-control:*` 等 Codex Desktop 远端主机 MUST 保持 `thread read` 兼容且继续拒绝所有写操作与 `wait`，绝不回退本机。远端错误响应 MUST 脱敏为客户端安全文案，不泄漏宿主绝对路径、Git stderr 或 Peer URL/Token。

#### Scenario: 跨机不支持操作在 CLI、HTTP 与 MCP 均被一致拒绝
- **WHEN** 调用方对远端 `thread://<id>?hostId=...` 执行 `watch`、`export` 或 `file` 读取
- **THEN** 系统在查找本机同 ID Thread 前明确拒绝，不误操作本机 Thread

#### Scenario: Codex Desktop 远端主机保持只读边界
- **WHEN** 调用方对 `remote-ssh*` 或 `remote-control:*` 主机执行 `thread read` 以外的写操作或 `wait`
- **THEN** 系统明确拒绝且不回退到本机，而 `thread read` 保持既有行为不变
