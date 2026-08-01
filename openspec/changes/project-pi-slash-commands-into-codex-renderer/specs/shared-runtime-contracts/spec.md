## ADDED Requirements

### Requirement: Shared command catalog contracts are browser-safe, strict, and bounded
Shared Contracts SHALL export browser-safe strict Runtime Schemas and types for normalized Harness command descriptors and catalogs. A descriptor SHALL contain only `name`, `description`, `argumentHint`, and `kind`; a catalog SHALL contain only a bounded command array with unique names. The schemas SHALL reject leading slashes, whitespace or control characters in names, undeclared fields, duplicate names, and unbounded strings or arrays.

#### Scenario: Renderer validates a mixed catalog
- **WHEN** a catalog contains valid `command`, `prompt`, `skill`, and `unknown` descriptors with unique bounded names
- **THEN** the public Runtime Schema SHALL accept the complete catalog without Node.js, Electron, or Harness SDK imports

#### Scenario: Catalog leaks native provenance
- **WHEN** a descriptor includes a path, package location, executable, Native Ref, Provider payload, credential, or another undeclared field
- **THEN** the strict Runtime Schema SHALL reject it

#### Scenario: Catalog is ambiguous or unbounded
- **WHEN** names are duplicated, contain a leading slash or whitespace, descriptions or hints exceed their bounds, or the command count exceeds its bound
- **THEN** the Runtime Schema SHALL reject the complete catalog rather than truncate it

### Requirement: Shared draft command inspection composes with fixed Harness inspection
The fixed browser-safe Harness inspection params SHALL support an optional command-catalog inclusion flag and the normalized configuration needed to identify the draft context. Command inclusion SHALL require one valid exact cwd. The ready inspection result SHALL carry either a validated command catalog or a structured command-discovery error without turning an otherwise ready Harness into an unavailable Harness.

#### Scenario: Draft requests Model and command inspection
- **WHEN** Renderer sends a valid registered Harness ID, exact cwd, supported configuration, and command inclusion flag
- **THEN** the strict params schema SHALL accept only those declared fields
- **AND** the ready result SHALL validate Model inspection separately from command discovery

#### Scenario: Command inspection fails for an installed Harness
- **WHEN** native command discovery fails but Harness installation and Model inspection remain ready
- **THEN** the result SHALL preserve `status=ready` and contain a structured command-catalog error

#### Scenario: Command inclusion lacks cwd
- **WHEN** command inclusion is true without a valid non-blank cwd
- **THEN** the params schema SHALL reject the request before Renderer or Host consumes it

### Requirement: Shared live command-list contracts are fixed and strict
Shared Contracts SHALL export a fixed strict request schema for live external Thread command discovery containing only one valid Host Thread ID and optional refresh, plus a strict response schema containing the normalized catalog. The contract SHALL expose no generic method, arbitrary payload, Native Ref, cwd, source path, Prompt, Transcript, or Harness-native field.

#### Scenario: Renderer requests current Thread commands
- **WHEN** Renderer submits one valid Host Thread ID and optional refresh and receives a valid normalized catalog
- **THEN** the method-specific Runtime Schemas SHALL accept the request and response

#### Scenario: Native command method is injected
- **WHEN** request params include a Pi RPC method, Harness ID override, cwd override, native payload, or undeclared field
- **THEN** the strict schema SHALL reject the request

#### Scenario: Response contains native metadata
- **WHEN** a live response includes command paths, Native Session identity, configuration payload, or undeclared fields
- **THEN** the strict schema SHALL reject the response

## MODIFIED Requirements

### Requirement: Shared Model control params are method-specific
Shared Contracts SHALL provide separate strict Runtime Schemas for draft Harness inspection params, current-process Thread Model-selection params, and live Thread command-list params, and SHALL NOT provide an arbitrary method/payload control envelope. Harness inspection params SHALL carry a validated opaque Harness ID, optional cwd and refresh, optional supported Model and Thinking configuration, and optional command-catalog inclusion; they MUST NOT be restricted to one concrete Harness. Command-catalog inclusion SHALL require a valid exact cwd.

#### Scenario: Valid registered Harness inspection params
- **WHEN** the control boundary receives a non-empty Harness identity with optional cwd, refresh, supported configuration, and command-catalog inclusion consistent with cwd requirements
- **THEN** the inspection params schema SHALL accept and preserve only those declared fields

#### Scenario: Valid Thread Model selection params
- **WHEN** the control boundary receives a non-empty Host Thread ID and valid Harness Model Ref
- **THEN** the Thread selection params schema SHALL accept the request

#### Scenario: Valid live Thread command params
- **WHEN** the control boundary receives one non-empty Host Thread ID and optional refresh
- **THEN** the live command-list params schema SHALL accept only those fields

#### Scenario: Native method is injected
- **WHEN** a control request includes a Pi RPC method name, native Provider/Model fields, arbitrary native payload, or another undeclared property
- **THEN** the method-specific schema SHALL reject the request before Host or Renderer consumes it
