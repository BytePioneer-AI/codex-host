## MODIFIED Requirements

### Requirement: External Harness create routing uses a finite Protocol Core registry
Protocol Core SHALL decode official Codex Models and the finite native transport carriers for Pi and Claude Code. Each external carrier SHALL identify one external Harness ID and MAY carry only that Harness's bounded opaque Model Ref according to its registered format, without exposing Adapter implementation or native Model configuration.

#### Scenario: Pi transport token is decoded
- **WHEN** `thread/start.model` is `codexhost/pi-native` or a valid selected Pi carrier
- **THEN** Protocol Core routes the create to external Harness `pi` and preserves any opaque Pi Model/Thinking selection

#### Scenario: Claude transport token is decoded
- **WHEN** `thread/start.model` is `codexhost/claude-code-native` or that token plus one valid opaque Claude Model Ref
- **THEN** Protocol Core routes the create to external Harness `claude-code` and preserves only the optional opaque Model Ref

#### Scenario: Malformed Claude carrier is received
- **WHEN** a Claude-prefixed carrier has an empty, oversized, extra, or invalid Model component
- **THEN** Protocol Core rejects the external create explicitly and does not classify it as official Codex traffic

#### Scenario: Official Model is decoded
- **WHEN** `thread/start.model` is not a registered external transport carrier
- **THEN** Protocol Core classifies it as official Codex Model traffic without altering the Model value

### Requirement: Protocol Core owns finite transport Model decoding
Protocol Core SHALL decode Desktop transport Model carriers for each finite external Harness and SHALL return only an opaque Harness Model Ref, optional supported configuration values, no override, or a non-matching result to Host Runtime. Host Runtime MUST NOT parse Pi or Claude Model carrier prefixes.

#### Scenario: Pi selected carrier reaches a Pi Thread
- **WHEN** an existing Pi Thread receives a valid selected Pi transport Model carrier
- **THEN** Protocol Core returns its opaque Harness Model Ref and optional Thinking selection
- **AND** generic Host routing applies or verifies that configuration through the owning Session

#### Scenario: Claude selected carrier reaches a Claude Thread
- **WHEN** an existing Claude Thread receives a valid Claude transport carrier containing one Model Ref
- **THEN** Protocol Core returns that opaque Ref without decoding the Claude SDK value
- **AND** generic Host routing applies or verifies it through the owning Claude Session

#### Scenario: Foreign carrier reaches an external Thread
- **WHEN** an external Thread receives a transport Model carrier that does not belong to its Harness
- **THEN** Protocol Core reports that the carrier does not match
- **AND** Host does not reinterpret it as a Harness Model Ref

## ADDED Requirements

### Requirement: Claude create configuration remains request-scoped
Host Runtime SHALL pass a Claude Model Ref decoded from the exact `thread/start.model` carrier only to that create's `ClaudeCodeAdapter.open(create)` input. It MUST NOT retain a process-level next Model, parse the Ref, or use a failed Claude configuration as a reason to route the request to Codex or Pi.

#### Scenario: Two Claude drafts select different Models
- **WHEN** two Claude Composer creates carry different valid Model Refs
- **THEN** Host opens each Claude Session with only its own Ref
- **AND** neither create consumes or overwrites the other selection

#### Scenario: Claude create Model becomes unavailable
- **WHEN** Claude Code rejects the selected Model during lazy first-Turn initialization
- **THEN** the owning Claude Turn fails explicitly
- **AND** the Thread remains Claude-owned without fallback to another Harness
