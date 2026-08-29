# running-desktop-attachment Specification

## Purpose
Define codexhost Desktop instance coordination: clean controlled launch, nonce-authenticated reuse, stale ownership recovery, explicit preservation of independently started official instances, and ownership-scoped cleanup.
## Requirements
### Requirement: Launcher coordinates controlled and official Desktop instances
The production Launcher SHALL distinguish stale-launcher recovery, clean Desktop launch, controlled-instance reuse, and an independently started official Desktop.

#### Scenario: Stale launcher state
- **WHEN** launcher state exists but its Desktop and control endpoint are both absent
- **THEN** Launcher MUST remove only the validated stale state and retry startup

#### Scenario: No Desktop is running
- **WHEN** no target Codex Desktop process exists
- **THEN** Launcher MUST use the existing clean launch with Shim, Host configuration, temporary Inspector, Renderer, and Controller supervision

#### Scenario: Independently started official Desktop is running
- **WHEN** a target Codex Desktop root exists without a live codexhost owner and authenticated Controller
- **THEN** Launcher MUST instruct the user to fully quit Codex before starting codexhost
- **AND** it MUST NOT inject, restart, or terminate that Desktop

### Requirement: Controlled Desktop attachment reuses the owning Controller
A second Launcher for an existing codexhost-controlled Desktop SHALL rely on the per-user ownership lock and a nonce-authenticated Controller handshake. It MUST NOT repeat Inspector, Desktop PID, or Shim/Host process-tree validation already completed before the owning Launcher published its descriptor, and it MUST NOT install a competing Controller.

#### Scenario: Healthy controlled instance
- **WHEN** another Launcher owns the lock and the descriptor's Controller returns `ready` for the exact nonce
- **THEN** the Controller MUST ensure the Renderer remains installed, activate its own Desktop window, and let the second Launcher return success without creating another Desktop or Host

#### Scenario: Controller handshake is unavailable or rejected
- **WHEN** the descriptor is absent, the endpoint is unavailable, the nonce is rejected, or Controller activation fails
- **THEN** Launcher MUST NOT treat the Desktop as a controlled reusable instance

### Requirement: Independently started official Desktop remains unmanaged
Launcher SHALL NOT attempt second-activation Inspector/CDP bootstrap or app-server rebinding for an independently started official Desktop on any platform.

#### Scenario: Official Desktop blocks clean launch
- **WHEN** the official Desktop is already running outside codexhost
- **THEN** Launcher MUST return a concrete full-quit instruction immediately
- **AND** it MUST leave the existing Desktop and its app-server unchanged

### Requirement: Runtime attachment state is minimal and recoverable
Launcher SHALL persist only the minimum per-user runtime descriptor needed to validate a controlled instance, using atomic replacement and restrictive local access where supported. Runtime state MUST NOT contain Prompt, Transcript, credentials, Thread IDs, project paths, or arbitrary environment data.

#### Scenario: Controlled launch publishes state
- **WHEN** a clean Desktop, Controller, Renderer, and Shim/Host chain become ready
- **THEN** Launcher MUST atomically publish only the Launcher owner PID, Controller port, and attachment nonce

#### Scenario: Controlled Desktop exits
- **WHEN** the owning Desktop and Controller shut down
- **THEN** Launcher MUST remove its matching runtime descriptor without deleting a newer instance's state

### Requirement: Runtime cleanup follows ownership
Launcher SHALL clean only the controlled Desktop resources and runtime descriptor owned by its clean launch. It MUST NOT automatically kill a Desktop that existed before the launch attempt.

#### Scenario: User closes a controlled Desktop
- **WHEN** the owning controlled Desktop exits
- **THEN** its Launcher, Controller, and matching runtime descriptor MUST stop or be removed within a bounded time

### Requirement: Real Windows evidence covers instance coordination
The change SHALL record real Windows user behavior without persisting PIDs, ports, command lines, environment, or user data.

#### Scenario: Instance coordination matrix
- **WHEN** validation covers official-first launch, clean codexhost launch, controlled repeat/double launch, official reactivation, stale recovery, and user quit
- **THEN** it MUST record controlled reuse separately from the explicit full-quit behavior for an independently started official Desktop

### Requirement: 首次 Controller readiness SHALL 使用严格compatible结果
Launcher与首次Desktop Controller之间的readiness协议 SHALL使用有版本、单行、严格且有界的结构化结果。当前生产成功结果 MUST为`compatible`且issues为空，MUST NOT携带兼容warning、降级能力或用户决策数据。已发布实例的nonce-authenticated Attachment Server协议 SHALL保留受控实例激活能力，但 SHALL NOT提供兼容弹窗专用更新命令。

#### Scenario: Controller ready
- **WHEN** Controller已启动Attachment Server并进入受管监督
- **THEN** Controller SHALL返回Schema version 2、state `compatible`与空issues
- **AND** Launcher SHALL继续Runtime Descriptor发布和detach流程而不显示兼容提示

#### Scenario: readiness结果包含旧warning
- **WHEN** Controller stdout包含`compatible-with-warning`、`degraded`、非空issues、未知Schema、未知字段、多行或malformed JSON
- **THEN** Launcher SHALL将其视为技术启动错误
- **AND** MUST NOT把它降级为可继续的兼容warning

### Requirement: Launcher SHALL 在严格readiness后发布受管运行状态
Launcher SHALL在收到有效的compatible-only readiness并完成既有Host chain检查后发布本次Runtime Descriptor并detach。Launcher MUST NOT等待兼容warning确认、写入兼容确认、调用兼容专用更新检查或因Renderer兼容状态切换原版Codex。

#### Scenario: 有效readiness
- **WHEN** Controller返回严格有效的compatible-only readiness且Host chain ready
- **THEN** Launcher SHALL发布受管Runtime Descriptor并完成正常后台监督
- **AND** SHALL不显示兼容弹窗

#### Scenario: Renderer集成仍在恢复
- **WHEN** Controller内部Renderer Session不可用但已按非阻塞策略返回有效readiness
- **THEN** Launcher SHALL继续受管启动
- **AND** Renderer恢复 SHALL由Controller后台处理而不是Launcher用户决策处理
