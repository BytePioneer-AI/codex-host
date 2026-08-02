# claude-code-tool-approval-session Specification

## Purpose
Define how Claude Code ordinary Tool permission callbacks become bounded Host Approvals while preserving native policy evaluation, exact callback correlation, private permission suggestions, and convergent lifecycle cleanup.
## Requirements
### Requirement: Claude Adapter exposes ordinary Tool permission callbacks as Approval

The Claude Code Adapter SHALL map each validated native `canUseTool` callback other than `AskUserQuestion` into the bounded Host Approval capability. It SHALL preserve Claude Code's native Tool set, the current native Session Permission Mode, and native permission-rule evaluation, and SHALL NOT register a codexhost Tool or infer an Approval when no native callback occurs.

#### Scenario: Claude Edit or Bash requires user permission

- **WHEN** Claude Code invokes `canUseTool` for an ordinary Tool during an active Turn with valid Tool Use and control Request IDs
- **THEN** the Adapter SHALL emit one Host Approval owned by that Turn with one-shot Allow and Deny actions plus only the broader scope represented by a valid native suggestion set
- **AND** complete Tool input, native IDs, SDK suggestions, and callback objects SHALL remain private to `packages/adapters/claude-code`

#### Scenario: Claude Tool is already allowed by native policy

- **WHEN** Claude Code executes a Tool without invoking `canUseTool` because native mode or rules already allow it
- **THEN** the Adapter SHALL NOT synthesize an Approval
- **AND** this slice SHALL make no Tool or File Change projection claim for that execution

#### Scenario: Permission callback is malformed or outside an active Turn

- **WHEN** a callback lacks required native identity, duplicates an active control Request ID, has invalid display metadata, or arrives without an owning active Turn
- **THEN** the transport SHALL deny that callback without emitting a Host Interaction
- **AND** it SHALL NOT affect another callback or Turn

### Requirement: Claude Approval decisions return to the exact SDK callback

The Claude transport SHALL privately correlate Host Interaction ID, native Tool Use ID, native control Request ID, original Tool input, AbortSignal, and one deferred `PermissionResult`. It SHALL settle exactly one matching callback for each accepted Host response.

#### Scenario: User allows the Tool once

- **WHEN** the Host selects `allowOnce` for a pending Claude Approval
- **THEN** the transport SHALL resolve only that callback with `behavior: "allow"`, the unchanged original input, matching Tool Use ID, and temporary-user decision classification
- **AND** it SHALL omit `updatedPermissions` even when native suggestions were present

#### Scenario: User applies the native permission suggestions

- **WHEN** the Host selects the declared `allowForSession` or `allowAlways` action for a pending Claude Approval
- **THEN** the transport SHALL resolve only that callback with `behavior: "allow"`, unchanged original input, matching Tool Use ID, permanent-user decision classification, and the exact complete original suggestion array as `updatedPermissions`
- **AND** it SHALL NOT synthesize, widen, split, persist, or otherwise rewrite a Claude permission update

#### Scenario: User denies the Tool

- **WHEN** the Host selects `deny` or the reviewed Desktop control is dismissed
- **THEN** the transport SHALL resolve only that callback with `behavior: "deny"`, a non-sensitive message, matching Tool Use ID, and user-reject decision classification
- **AND** denial SHALL NOT by itself invoke `Query.interrupt()` or complete the Turn

#### Scenario: Multiple callbacks are pending

- **WHEN** one active Claude Turn produces more than one valid permission callback
- **THEN** each Approval SHALL retain independent Host and native correlation
- **AND** responding to one SHALL NOT settle, close, or alter another

### Requirement: Claude pending Approvals converge on response, abort, and terminal paths

A Claude Approval SHALL appear after `turn.started`, close exactly once, and close before the owning Turn terminal. SDK AbortSignal, Turn cancellation, Session close, transport fault, and impossible native terminal state SHALL remove every pending resolver and listener.

#### Scenario: SDK aborts a pending callback

- **WHEN** the callback AbortSignal fires before a Host decision is accepted
- **THEN** the Adapter SHALL close the matching Approval as cancelled and settle or release the native callback according to the SDK abort contract
- **AND** a later Host response SHALL return `invalidState`

#### Scenario: Turn cancel interrupts a pending Approval

- **WHEN** `turn.cancel` is accepted while Claude is waiting for permission
- **THEN** the Adapter SHALL invoke the existing Query interrupt path and close the Approval before the native Turn terminal
- **AND** the same Session SHALL accept a later Turn after cancellation settles

#### Scenario: Native Turn settles with an Approval still pending

- **WHEN** native terminal processing begins while a callback remains pending
- **THEN** the Adapter SHALL deny or supersede the callback and close the Approval before `turn.completed`
- **AND** it SHALL still emit only one Turn terminal

### Requirement: Claude Approval preserves native suggestion scope without owning policy

The Approval capability SHALL add only ordinary Tool permission Approval and exact response conversion. It SHALL remain independent from the separate Permission Mode control and SHALL NOT add automatic approval, codexhost-owned permission rules, Tool Item mapping, File Change mapping, Diff inference, Tool history, or custom Renderer Approval UI.

#### Scenario: SDK supplies Session permission update suggestions

- **WHEN** `canUseTool` includes a non-empty valid suggestion set whose destinations are all `session` or `cliArg`
- **THEN** the Adapter SHALL expose one `allowForSession` action in addition to one-shot Allow and Deny
- **AND** selecting it SHALL return the complete original set only to the matching SDK callback

#### Scenario: SDK supplies persistent permission update suggestions

- **WHEN** a non-empty valid suggestion set includes `userSettings`, `projectSettings`, or `localSettings`
- **THEN** the Adapter SHALL expose one `allowAlways` action in addition to one-shot Allow and Deny
- **AND** selecting it SHALL return the complete original set only to the matching SDK callback

#### Scenario: SDK supplies no usable permission update suggestions

- **WHEN** suggestions are absent, empty, malformed, or contain an unknown destination
- **THEN** the Adapter SHALL expose only one-shot Allow and Deny
- **AND** no broader Host or SDK response SHALL be accepted

#### Scenario: Claude Tool input resembles a file change

- **WHEN** Edit, Write, Bash, or another Tool input contains paths, old/new strings, commands, or proposed content
- **THEN** the Approval MAY use only bounded SDK display metadata required by the reviewed confirmation UI
- **AND** it SHALL NOT infer a successful File Change, reliable Patch, or completed Tool from that input
