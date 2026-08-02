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

#### Scenario: Pi has no native Permission Mode

- **WHEN** Pi is inspected or opened
- **THEN** it SHALL report `selectPermissionMode=false`, omit the catalog, and reject `permissionMode.select` as unsupported

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

### Requirement: Permission Mode remains independent from Approval and rules

Permission Mode SHALL define the native Session execution baseline only. Selecting a mode SHALL NOT create a permission rule, answer a pending Approval, change Sandbox configuration, or imply that every Tool will execute without a callback.

#### Scenario: Tool callback still occurs after mode selection

- **WHEN** Claude Code invokes `canUseTool` under the selected mode
- **THEN** the callback SHALL continue through the separate Approval capability
- **AND** codexhost SHALL NOT derive an allow rule from the selected mode
