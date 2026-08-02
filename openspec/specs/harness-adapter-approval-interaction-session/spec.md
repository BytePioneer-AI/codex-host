# harness-adapter-approval-interaction-session Specification

## Purpose
Define the UI-independent Host Approval contract, reviewed Codex Desktop projection, exact declared response routing, lifecycle convergence, and privacy boundaries for native Harness permission decisions.
## Requirements
### Requirement: Approval projection is version-reviewed against native Desktop behavior

A controlled Gate on the supported Codex Desktop SHALL identify one native request that truthfully represents generic external-Harness Approval and returns exact one-shot and declared broader-scope decisions. The implementation SHALL use only that reviewed request shape and SHALL re-gate it when the supported Desktop protocol or Renderer behavior changes.

#### Scenario: Reviewed native MCP Approval is available

- **WHEN** a synthetic external Turn sends the reviewed MCP Tool Approval form on Codex Desktop `26.727.6591.0`
- **THEN** Desktop SHALL present bounded context with `Allow once` and `Deny`, plus only the Session or always scope declared through reviewed `persist` metadata
- **AND** Desktop SHALL return `accept`, `decline`, or `cancel` with reviewed `content` and `_meta.persist` fields that distinguish the selected scope
- **AND** the implementation SHALL NOT use Question, fabricated Command/File Change/permission semantics, or custom Renderer UI

### Requirement: Harness Session exposes UI-independent Approval interactions

A `HarnessSession` SHALL expose a native permission decision as a typed `HostApprovalInteraction` through its single ordered output stream and SHALL accept a typed Approval response through `interaction.respond`. An Approval SHALL expose `allowOnce` and `deny`, and MAY expose `allowForSession` or `allowAlways` only when the native Harness offered that scope. It SHALL NOT expose native callback IDs, Tool input, permission suggestions, or Harness protocol payloads.

#### Scenario: Native action requires one-shot approval

- **WHEN** an active native Turn requests an explicit user permission decision
- **THEN** the Session SHALL emit an Approval with a Host Interaction ID, owning Host Turn ID, bounded title, optional bounded description, exactly one `allowOnce` action, exactly one `deny` action, and only declared optional broader actions
- **AND** the Approval SHALL remain distinct from Question and ordinary Tool output

#### Scenario: Native action offers broader permission scopes

- **WHEN** the native request also offers Session, project, user, local, or CLI permission updates
- **THEN** the Host Approval SHALL expose only the bounded scope effect offered by the native request
- **AND** it SHALL NOT carry an opaque permission update through the public contract or let Host Runtime construct a native rule

### Requirement: Approval responses are exact and declared

The Session SHALL accept an Approval response only for a pending Approval owned by that Session and active Turn. It SHALL validate the response type and declared action ID before writing one native decision, and one accepted response SHALL NOT itself complete the Turn.

#### Scenario: User allows one native action

- **WHEN** the Host submits the declared `allowOnce` action for a pending Approval
- **THEN** the Adapter SHALL allow only the matching native request without changing a persistent or Session permission rule
- **AND** the Session SHALL emit exactly one `interaction.closed(responded)` after the native response is accepted

#### Scenario: User denies one native action

- **WHEN** the Host submits the declared `deny` action or dismisses the reviewed native Approval control
- **THEN** the Adapter SHALL deny only the matching native request without cancelling the Turn
- **AND** the Interaction SHALL close exactly once as responded or cancelled according to the reviewed response path

#### Scenario: User accepts a declared broader native scope

- **WHEN** the Host submits a declared `allowForSession` or `allowAlways` action for a pending Approval
- **THEN** the Adapter SHALL apply only the exact provider-owned native suggestion set associated with that action
- **AND** the public response SHALL contain only the declared action ID, not the native update payload

#### Scenario: Invalid or duplicate Approval response arrives

- **WHEN** a response references an unknown, closed, wrong-Session, wrong-type, or undeclared Approval action
- **THEN** the Session SHALL return `invalidRequest` or `invalidState`
- **AND** it SHALL NOT write a native response or alter another pending Interaction

### Requirement: Approval lifecycle converges before the Turn terminal

Every exposed Approval SHALL belong to one active Turn, SHALL appear after `turn.started`, and SHALL close exactly once before that Turn's unique terminal event. Turn cancel, Session close, transport fault, native abort, and terminal processing SHALL leave no Approval pending.

#### Scenario: Approval is requested before ordinary Assistant output

- **WHEN** the native permission callback arrives before text or Tool output
- **THEN** the Session SHALL emit it after `turn.started` and allow an immediate response
- **AND** it SHALL NOT deadlock waiting for later output

#### Scenario: Turn is cancelled while Approval is pending

- **WHEN** the Host accepts `turn.cancel` for the owning Turn
- **THEN** the Adapter SHALL request native interrupt and close the pending Approval before the Turn terminal
- **AND** cancel acceptance alone SHALL NOT fabricate a successful or failed native terminal

#### Scenario: Session closes or faults while Approval is pending

- **WHEN** Session close or transport fault occurs with one or more pending Approvals
- **THEN** every Approval SHALL close before active Item, Turn, Session, or output-stream terminal processing
- **AND** no callback resolver, timer, or native correlation SHALL remain reachable

### Requirement: Codex projection uses one reviewed native Approval request

Protocol Core and Host Runtime SHALL project a pending Host Approval through one version-reviewed native Codex app-server Approval server request and SHALL validate the Desktop response before executing `interaction.respond`. The projector SHALL NOT encode Approval as `item/tool/requestUserInput`, fabricate an unsupported Tool or File Change, or add a custom Renderer control.

#### Scenario: Supported Desktop renders an external Approval

- **WHEN** a pending Host Approval reaches the reviewed supported Desktop build
- **THEN** the Desktop SHALL render a native confirmation control with truthful bounded context, one-shot Allow and Deny behavior, and only declared Session or always actions
- **AND** the Host SHALL correlate its response through a Host-owned JSON-RPC request ID without exposing native Harness IDs

#### Scenario: Desktop Approval response is malformed or unsupported

- **WHEN** Desktop returns malformed `action`, `content`, or `_meta`, an undeclared scope, an unsupported action, or an error for a Host-owned Approval request
- **THEN** the Host SHALL fail closed by denying or cancelling the owning Approval through its typed response path
- **AND** it SHALL NOT forward malformed data to the Adapter or reinterpret the response as Question

#### Scenario: Response is not Host-owned

- **WHEN** Desktop sends a response whose ID is not in the Host Approval registry
- **THEN** the Host SHALL forward the original frame unchanged to the official app-server

#### Scenario: Host resolves a pending Approval externally

- **WHEN** Turn cancel, Interaction close, fault, Thread deletion, or Host shutdown retires a Host-owned Approval before Desktop responds
- **THEN** Host Runtime SHALL remove all authoritative pending state and send `serverRequest/resolved` before the owning terminal sequence completes
- **AND** it SHALL consume every duplicate or late response in the reserved Host Approval Request-ID namespace without executing a Tool, forwarding the frame, or affecting another Interaction

#### Scenario: Supported Desktop behavior changes

- **WHEN** a supported Desktop version no longer renders or responds to the reviewed MCP Tool Approval shape with the required declared scope semantics
- **THEN** product support for this projection SHALL fail closed pending a new Gate and reviewed spec and design revision
- **AND** it SHALL NOT add an implicit fallback to Question, fabricated native semantics, or custom Renderer UI

### Requirement: Approval data remains private and ephemeral

Approval display text and decisions SHALL remain in the live Interaction path, while complete Tool input, SDK suggestions, native IDs, and native response objects SHALL remain inside the concrete Adapter. codexhost SHALL NOT write them to Mapping Store, committed Fixtures, route observations, or ordinary diagnostics.

#### Scenario: Approval closes

- **WHEN** an Approval responds, cancels, faults, or reaches Turn terminal cleanup
- **THEN** Host and Adapter in-memory correlation SHALL be removed
- **AND** no normalized Approval transcript or native permission update SHALL be persisted by codexhost
