# registered-harness-routing Specification

## Purpose
TBD - created by archiving change implement-registered-harness-text-vertical-slice. Update Purpose after archive.
## Requirements
### Requirement: External Harness create routing uses a finite Protocol Core registry
Protocol Core SHALL decode official Codex Models and the finite native transport carriers for Pi and Claude Code. Each external carrier SHALL identify one external Harness ID and MAY carry only that Harness's bounded opaque Model Ref and declared configuration components according to its registered format, without exposing Adapter implementation or native SDK configuration.

#### Scenario: Pi transport token is decoded
- **WHEN** `thread/start.model` is `codexhost/pi-native` or a valid selected Pi carrier
- **THEN** Protocol Core routes the create to external Harness `pi` and preserves any opaque Pi Model/Thinking selection

#### Scenario: Claude transport token is decoded
- **WHEN** `thread/start.model` is `codexhost/claude-code-native`, that token plus one valid opaque Claude Model Ref, or the Model form plus one valid Permission Mode ID
- **THEN** Protocol Core routes the create to external Harness `claude-code` and preserves only the optional opaque Model and mode selection

#### Scenario: Malformed Claude carrier is received
- **WHEN** a Claude-prefixed carrier has an empty, oversized, extra, invalid, or mode-without-Model component
- **THEN** Protocol Core rejects the external create explicitly and does not classify it as official Codex traffic

#### Scenario: Official Model is decoded
- **WHEN** `thread/start.model` is not a registered external transport carrier
- **THEN** Protocol Core classifies it as official Codex Model traffic without altering the Model value

### Requirement: Host owns external Threads through registered HarnessAdapters
Host Runtime SHALL route all external create, turn, interrupt, read, rename, delete, output, fault, and close operations through one external Thread implementation keyed by Harness ID. It MUST NOT contain Pi RPC or Claude SDK event mapping.

#### Scenario: Registered Claude Thread starts
- **WHEN** a Claude transport create reaches a Host with a registered Claude Code Adapter
- **THEN** Host SHALL open that Adapter through HarnessAdapter and return an external Codex Thread
- **AND** later Turn outputs SHALL pass through the same CodexTurnProjector used by Pi

#### Scenario: Two concrete Adapters are registered
- **WHEN** Pi and Claude Code Threads coexist in one Host
- **THEN** each Thread SHALL remain bound to its creating HarnessSession
- **AND** operations on one Thread SHALL never invoke the other Adapter

#### Scenario: Valid transport token has no Adapter
- **WHEN** an external token reaches a Host without its Adapter registration
- **THEN** Host SHALL return an explicit unavailable error
- **AND** it SHALL NOT forward that request or its future content to official Codex

### Requirement: Existing response ordering and lifecycle projection are reused
The generic external Thread path SHALL retain response-before-notification ordering, HarnessSession output ordering, current Codex Item/Turn projection, process-local thread/read, local rename/delete, and bounded Host shutdown for every registered external Harness.

#### Scenario: Early Claude outputs race acceptance response
- **WHEN** Claude Harness outputs are queued before `turn/start` execute resolves
- **THEN** Host SHALL write the JSON-RPC response before forwarding the first lifecycle notification

#### Scenario: Claude cancellation output races interrupt response
- **WHEN** cancellation terminal output is queued before `turn/interrupt` response
- **THEN** Host SHALL write the interrupt response first
- **AND** the projected Turn SHALL later complete interrupted exactly once

#### Scenario: Host closes mixed external Threads
- **WHEN** Host exits with Pi and Claude Sessions open
- **THEN** it SHALL close every Session and both Adapters without depending on Harness-specific branches

### Requirement: Claude Host registration is explicitly development-gated
The production composition root SHALL always register Pi as before and SHALL register Claude Code only when an explicit development environment switch is enabled. The default Agent SHALL remain Codex or Pi.

#### Scenario: Default Host starts
- **WHEN** the Claude development switch is absent
- **THEN** Host SHALL not construct a Claude Code Adapter
- **AND** all existing Codex and Pi routing behavior SHALL remain unchanged

#### Scenario: Development Host starts with Claude
- **WHEN** the Claude development switch is explicitly enabled
- **THEN** Host SHALL register one Claude Code Adapter using the user-installed executable configuration
- **AND** the Claude transport token SHALL become routable

### Requirement: Validation distinguishes Host proof from Desktop proof
Hermetic Host tests SHALL use two Fake HarnessAdapters. Real Adapter tests and real Desktop tests SHALL be separately and explicitly enabled, bounded, and privacy-preserving.

#### Scenario: Real Adapter Host Gate passes
- **WHEN** the explicit real Adapter Gate sends a synthetic text Turn through Host Runtime
- **THEN** the report SHALL confirm Claude selection, one Native Session, ordered text projection, and terminal outcome without recording content or complete IDs

#### Scenario: Real Codex Desktop Gate passes
- **WHEN** a user explicitly enables Claude in the controlled Renderer, submits a synthetic Prompt, cancels or completes it, and continues the same Thread
- **THEN** sanitized Renderer and Host observations SHALL associate the Claude create and Turn
- **AND** only then MAY the change claim a real Claude-to-Codex-UI text chain

### Requirement: Host reports persisted Thread ownership without restoring Sessions
Host Runtime SHALL handle the fixed `codexhost/thread/ownership/list` request by reading external Thread ownership directly from the Mapping Store repository. It SHALL return exactly one ordered ownership entry per requested Thread ID, classify a stored record as its immutable external Harness and an absent record as Codex, and MUST NOT call an Adapter, restore a HarnessSession, read a Snapshot, or forward the request to official Codex.

#### Scenario: Batch contains Codex and external Threads
- **WHEN** a valid ownership request contains an official Thread ID, a persisted Pi Thread ID, and a persisted development-gated Claude Code Thread ID
- **THEN** Host SHALL return Codex, Pi, and Claude Code ownership in the same order as requested
- **AND** it SHALL NOT open either external Adapter

#### Scenario: Persisted external runtime is unloaded
- **WHEN** ownership is requested for a stored external Thread after Host restart
- **THEN** Host SHALL report the stored Harness without resuming the Native Session or reading history

#### Scenario: Ownership metadata cannot be read
- **WHEN** Mapping Store lookup fails for any requested Thread
- **THEN** Host SHALL fail the complete fixed request explicitly rather than return a partial result or forward it to Codex

### Requirement: Harness controls dispatch through registered ownership
Host Runtime SHALL dispatch Harness inspection through the requested registered Harness ID and SHALL dispatch Thread Model or Permission Mode selection through the owning HarnessSession and its declared structural capability. These control paths MUST NOT require Pi ownership or inspect Harness-native configuration.

#### Scenario: Registered non-Pi Harness is inspected
- **WHEN** a valid Harness inspection request names a registered non-Pi Harness
- **THEN** Host SHALL call that Adapter's `inspect()` with the normalized cwd and refresh input
- **AND** it SHALL return the validated inspection without invoking PiAdapter

#### Scenario: Owning non-Pi Session supports Model selection
- **WHEN** a Model selection request references an external Thread whose Session declares `configuration.selectModel=true`
- **THEN** Host SHALL execute the existing `model.select` command on that owning Session
- **AND** it SHALL confirm the effective Model through ordered Session state without a Harness ID branch

#### Scenario: Owning Session supports Permission Mode selection
- **WHEN** the fixed Permission Mode request references a capable external Thread
- **THEN** Host SHALL execute `permissionMode.select`, consume the ordered current state, and return that mode without a Harness-specific native payload

#### Scenario: Owning Session does not support a requested control
- **WHEN** a Model or Permission Mode request references a Session whose corresponding capability is false
- **THEN** Host SHALL return an explicit unsupported error
- **AND** it SHALL NOT execute the command or invoke another Adapter

### Requirement: Protocol Core owns finite transport Model decoding
Protocol Core SHALL decode Desktop transport Model carriers for each finite external Harness and SHALL return only an opaque Harness Model Ref, optional supported configuration values, no override, or a non-matching result to Host Runtime. Host Runtime MUST NOT parse Pi or Claude Model carrier prefixes.

#### Scenario: Pi selected carrier reaches a Pi Thread
- **WHEN** an existing Pi Thread receives a valid selected Pi transport Model carrier
- **THEN** Protocol Core returns its opaque Harness Model Ref and optional Thinking selection
- **AND** generic Host routing applies or verifies that configuration through the owning Session

#### Scenario: Claude selected carrier reaches a Claude Thread
- **WHEN** an existing Claude Thread receives a valid Claude transport carrier containing one Model Ref and optional Permission Mode ID
- **THEN** Protocol Core returns those opaque selections without decoding Claude SDK values
- **AND** generic Host routing applies them through the owning Claude Session

#### Scenario: Foreign carrier reaches an external Thread
- **WHEN** an external Thread receives a transport Model carrier that does not belong to its Harness
- **THEN** Protocol Core reports that the carrier does not match
- **AND** Host does not reinterpret it as a Harness Model Ref

### Requirement: Composition root exclusively constructs concrete Adapters
The production composition root SHALL construct concrete Pi and development-gated Claude Adapters and SHALL inject the complete external Adapter registry into AppServerHost. AppServerHost SHALL depend on HarnessAdapter and MUST NOT import or construct PiAdapter or ClaudeCodeAdapter.

#### Scenario: Production Host starts
- **WHEN** the Host Runtime entry point creates AppServerHost
- **THEN** it SHALL first create the external Adapter registry through the composition module
- **AND** AppServerHost SHALL use exactly that injected registry

#### Scenario: Hermetic Host test starts
- **WHEN** a Host test needs one or more external Harnesses
- **THEN** it SHALL inject explicit Fake HarnessAdapters
- **AND** constructing AppServerHost SHALL NOT implicitly create Pi resources

### Requirement: Generic external routing consumes persisted ownership
Host Runtime SHALL consult the same external Thread repository for create, turn, interrupt, read, resume, rename, delete, inspect, and Fork routing. A persisted external resource MUST remain external when its Session is not currently loaded and MUST never fall through to official Codex.

#### Scenario: Persisted Thread is not loaded
- **WHEN** a resource request names a persisted Pi Thread after Host restart
- **THEN** Host SHALL select PiAdapter and resume or reject explicitly according to the operation
- **AND** it SHALL NOT forward the request to official Codex

### Requirement: Generic external Sessions support capability-driven history and Fork
Host Runtime SHALL use only HarnessAdapter Snapshot, Native Ref, capability, resume, and Fork interfaces for external history operations. It MUST NOT inspect Pi Entry locators, Claude UUIDs, or other native Fork payloads.

#### Scenario: Two Adapters have different Fork support
- **WHEN** Pi reports exact Fork and development-gated Claude reports unsupported
- **THEN** the same Host route SHALL execute Pi Fork and return an explicit Claude unsupported error without Harness-specific event mapping

### Requirement: Generic external routing owns bounded post-Fork rollback
Host Runtime SHALL use persisted ownership and the same HarnessAdapter Snapshot and Fork interfaces to handle the supported Desktop's post-Fork `thread/rollback` for an untouched derived external prefix. It MUST NOT add Pi Entry, Session file, or native rollback logic to Host, and an unsupported external rollback MUST NOT fall through to Codex.

#### Scenario: Registered Adapter realizes post-Fork rollback
- **WHEN** a mapped derived Thread still equals its persisted source prefix and its Adapter supports exact Fork
- **THEN** the generic Host route SHALL open the final exact Session through `HarnessAdapter.open(fork)` and replace the derived runtime
- **AND** no Harness-specific rollback command SHALL be required

### Requirement: Persisted completion precedes Desktop terminal projection
For every external Harness, Host SHALL persist a live Turn's NativeTurnRef and optional Checkpoint before projecting the corresponding successful terminal to Desktop. Store failure SHALL become an explicit failed lifecycle and MUST NOT expose an unpersisted Fork Anchor.

#### Scenario: Turn mapping write fails
- **WHEN** an Adapter emits a successful terminal with stable Native identity but Mapping Store cannot commit it
- **THEN** Host SHALL not project that success as a Forkable completed Turn

### Requirement: 已注册外部 Harness 必须共享一条 Usage 路由路径

Host Runtime MUST 从所属且已注册的 `HarnessSession` 消费规范化 Usage，保留最新的已加载 Thread 快照，并为每个外部 Harness 调用同一个 Protocol Core Usage projector。Host MUST NOT 查询 Pi RPC、Claude SDK、Model catalogs 或原生 Session 文件来获取 Usage；没有可投影 Usage 的有效外部 Thread MUST 保持外部归属，而不是回落到官方 Codex。

#### Scenario: Pi 与另一个 Adapter 共存

- **WHEN** Pi 和第二个已注册 Fake Adapter 分别为各自 Thread 发出 Usage
- **THEN** 两者 MUST 经过相同的 External Thread 状态和 Protocol projector 代码
- **AND** 一个 Session 的操作或 Telemetry MUST NOT 更新另一个 Thread

#### Scenario: 已注册 Harness 不提供 Usage

- **WHEN** 外部 Thread 所属 Session 没有报告可靠 Usage
- **THEN** Host MUST 继续通过该 Harness 路由其 Turn、history、control 和 close 操作
- **AND** Host MUST 只省略 Usage Notification

#### Scenario: 外部 Usage Notification 与 Response 发生竞态

- **WHEN** 已接受外部 Turn 的 Usage 在 `turn/start` Response 写出之前可用
- **THEN** 通用 Host 路由 MUST 保持 response-before-notification 顺序
- **AND** Host MUST NOT 要求 Harness 专用 Response gate

### Requirement: Claude create configuration remains request-scoped
Host Runtime SHALL pass Claude Model and Permission Mode selections decoded from the exact `thread/start.model` carrier only to that create's `ClaudeCodeAdapter.open(create)` input. It MUST NOT retain a process-level next configuration, parse Adapter-owned values, or use a failed Claude configuration as a reason to route the request to Codex or Pi.

#### Scenario: Two Claude drafts select different Models
- **WHEN** two Claude Composer creates carry different valid Model Refs
- **THEN** Host opens each Claude Session with only its own Ref
- **AND** neither create consumes or overwrites the other selection

#### Scenario: Claude create configuration becomes unavailable
- **WHEN** Claude Code rejects the selected Model or Permission Mode during lazy initialization
- **THEN** the owning Claude operation fails explicitly
- **AND** the Thread remains Claude-owned without fallback to another Harness

### Requirement: Host retains the current external transport configuration

After a successful current-Thread Permission Mode selection, Host Runtime SHALL update the Thread's transport carrier and request Mapping Store persistence. A later Claude Turn carrying a valid Permission Mode component SHALL also refresh that stored carrier. Persistence failure SHALL be diagnosed without changing the native Session result into another mode or routing the Thread to Codex.

#### Scenario: Claude Thread changes Permission Mode

- **WHEN** the owning Claude Session reports the current mode after a successful selection
- **THEN** Host SHALL encode that mode with the Thread's opaque Model Ref and persist the resulting carrier

#### Scenario: Host restores the Thread after restart

- **WHEN** a persisted Claude carrier contains Model and Permission Mode components
- **THEN** Thread inspection SHALL return that carrier and the next native operation SHALL reapply the stored mode through the owning Session
