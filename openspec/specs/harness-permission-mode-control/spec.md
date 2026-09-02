# harness-permission-mode-control Specification

## Purpose

Define the provider-native Permission Mode catalog and Session control contract without conflating Permission Mode with Tool Approval, permission rules, Sandbox, Account, or Billing Source.

## Requirements

### Requirement: Permission Mode capability is structural and provider-owned

A `HarnessAdapter` MAY expose a strict browser-safe Permission Mode catalog together with `configuration.selectPermissionMode=true`. Mode IDs SHALL remain opaque outside the owning Adapter. An Adapter without a native selectable mode SHALL report the capability as false and SHALL NOT publish a catalog.

#### Scenario: Claude exposes native modes

- **WHEN** Claude inspection confirms the official SDK Permission Mode setter
- **THEN** it SHALL return its normalized provider-native catalog and `selectPermissionMode=true`
- **AND** no Claude SDK enum or settings payload SHALL cross the Adapter boundary

#### Scenario: DeepSeek exposes dynamic native presets

- **WHEN** DeepSeek Harness inspection finds a valid native `permission` settings namespace
- **THEN** it SHALL derive the Permission Mode IDs, order, labels, and default from that namespace's schema and value
- **AND** codexhost SHALL NOT hardcode the deployment's preset catalog

#### Scenario: Pi has no native Permission Mode

- **WHEN** Pi is inspected or opened
- **THEN** it SHALL report `selectPermissionMode=false`, omit the catalog, and reject `permissionMode.select` as unsupported

### Requirement: Permission Mode change scope is structural

A capable Adapter SHALL report `configuration.permissionModeScope`. `live` means the current Session can change mode after creation. `atCreate` means the mode is fixed once the Session exists. The field SHALL default to `live` when omitted so existing capable Adapters keep live selection. `selectPermissionMode` SHALL remain true for an `atCreate` Adapter that still offers create-time selection.

#### Scenario: Grok mode is fixed at create

- **WHEN** Grok is inspected or opened
- **THEN** it SHALL report `selectPermissionMode=true` and `permissionModeScope=atCreate`
- **AND** `permissionMode.select` on an already-open Session SHALL return a non-retryable invalid request
- **AND** Host SHALL NOT persist `transportModelId` or `requestedPermissionModeId` for that rejected selection
- **AND** resume SHALL restore the stored Permission Mode while loading that Session
- **AND** restoring the mode SHALL NOT enable `permissionMode.select` on the already-open Session

### Requirement: Session state carries the current native mode

A capable Session SHALL accept an optional create-time mode and `permissionMode.select`, and SHALL publish `effectivePermissionModeId` through the ordered complete Session state. A successful command result SHALL contain only completion; callers SHALL use the state published before that result as the current mode.

#### Scenario: New Session starts with a selected mode

- **WHEN** create input carries a valid catalog mode
- **THEN** the owning Adapter SHALL initialize its native Session with that mode and publish it when native startup occurs

#### Scenario: Current Session changes mode

- **WHEN** the native setter accepts a valid mode, including while the native Agent loop is active when the provider supports it
- **THEN** the Adapter SHALL publish the resulting current mode and later operations SHALL continue under that Session mode

#### Scenario: Native setter rejects a mode

- **WHEN** the provider rejects a mode because of policy, model eligibility, or native availability
- **THEN** the command SHALL return a normal native failure and the Session SHALL retain its prior current mode
- **AND** rejection alone SHALL NOT fault the Session

#### Scenario: DeepSeek confirms a selected preset

- **WHEN** the DSH permission command reports success
- **THEN** the Adapter SHALL read the authoritative `permissions` projection and publish only its confirmed current value
- **AND** a missing, malformed, stale, or mismatched confirmation SHALL fail closed

### Requirement: Permission Mode remains Adapter-owned and independent from codexhost Approval and rules

Permission Mode SHALL define the provider-native Session execution baseline only. codexhost SHALL NOT create a permission rule, answer a pending Approval, synthesize a Sandbox change, or infer Tool behavior from the selected ID. A provider-native mode MAY atomically update its own Sandbox or Approval knobs; those effects SHALL remain owned and reported by that provider rather than translated into codexhost rules.

#### Scenario: Tool callback still occurs after mode selection

- **WHEN** Claude Code invokes `canUseTool` under the selected mode
- **THEN** the callback SHALL continue through the separate Approval capability
- **AND** codexhost SHALL NOT derive an allow rule from the selected mode

#### Scenario: DSH preset bundles native enforcement knobs

- **WHEN** DSH applies one permission preset by changing its native Sandbox and Approval policy
- **THEN** codexhost SHALL treat the resulting projection as one opaque Permission Mode
- **AND** it SHALL NOT expose, duplicate, or independently mutate those native knobs
