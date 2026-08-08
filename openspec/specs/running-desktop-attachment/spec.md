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

### Requirement: 首次 Controller readiness SHALL 携带严格兼容 warning
Launcher与首次Desktop Controller之间的readiness协议 SHALL 使用有版本、单行、严格且有界的结构化结果。成功结果 MAY携带已完成生产安装后的兼容warning；warning MUST NOT通过异常文本、stderr匹配或空stdout推断。已发布实例的nonce-authenticated Attachment Server协议保持不变。

#### Scenario: Controller无warning地ready
- **WHEN** Controller完成Title Policy、Renderer ownership、Draft Prewarm Policy和Renderer Adapter安装且没有warning
- **THEN** Controller SHALL返回结构化ready与空warnings
- **AND** Launcher SHALL继续现有Runtime Descriptor发布和detach流程

#### Scenario: Controller带未评审身份warning地ready
- **WHEN** Controller完成全部必要生产安装但标题服务身份未评审
- **THEN** Controller SHALL返回结构化ready及一个有界枚举warning
- **AND** Launcher SHALL在处理该warning前保持本次Controller和Desktop受监督

#### Scenario: readiness结果malformed
- **WHEN** Controller stdout包含未知Schema、未知字段、未知warning枚举、超长值、多行或malformed JSON
- **THEN** Launcher SHALL将其视为技术启动错误
- **AND** MUST NOT把它降级为可继续的兼容warning

### Requirement: Launcher SHALL 在用户决定后发布或放弃受管运行状态
Launcher SHALL在兼容warning已确认、被本地相同指纹确认抑制或用户选择获取最新版后，才发布本次Runtime Descriptor并detach。用户选择原版Codex时，Launcher MUST放弃本次受管状态并完成有界清理后启动官方Desktop。

#### Scenario: warning已被相同指纹确认
- **WHEN** Controller返回warning且Launcher找到完全匹配的有效本地确认
- **THEN** Launcher SHALL不重复提示并继续发布受管运行状态

#### Scenario: 用户打开Releases后继续
- **WHEN** 用户从warning提示选择获取最新版
- **THEN** Launcher SHALL打开固定Releases页面、记录本次确认并继续发布当前受管运行状态

#### Scenario: 原版Codex启动前清理
- **WHEN** 用户选择使用原版Codex
- **THEN** Launcher SHALL确保本次Controller、Shim、Host和受管Desktop已停止且Runtime Descriptor未发布
- **AND** 官方Desktop新进程 MUST NOT继承 `CODEX_CLI_PATH` 或任何 `CODEXHOST_*` 受管环境
