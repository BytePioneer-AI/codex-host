## ADDED Requirements

### Requirement: Shared Model Catalog contracts remain browser-safe and strict
Shared Contracts SHALL export browser-safe types and Runtime Schemas for opaque Harness Model Refs, normalized Model entries, Model Catalogs, inspection results, structural Model-selection capability, and effective Model state. V1 objects SHALL reject undeclared fields at the first formal control-boundary parse.

#### Scenario: Renderer validates a ready inspection
- **WHEN** Renderer receives a ready inspection containing valid opaque Refs, labels, a default Ref, and Model-selection capability
- **THEN** the public Runtime Schema accepts the complete value without importing Node.js, Electron, a Harness SDK, or another codexhost package

#### Scenario: Inspection leaks native configuration
- **WHEN** a catalog entry or inspection result contains an undeclared Provider object, base URL, price, path, credential, or arbitrary native payload
- **THEN** the strict Runtime Schema rejects the value rather than preserving or silently projecting it

#### Scenario: Model Ref is unsuitable for a transport carrier
- **WHEN** a Model Ref is empty, whitespace-only, over the bounded length, or contains characters outside the defined opaque transport-safe alphabet
- **THEN** the Model Ref Runtime Schema rejects it

### Requirement: Shared Model control params are method-specific
Shared Contracts SHALL provide separate strict Runtime Schemas for draft Harness inspection params and current-process Thread Model-selection params, and SHALL NOT provide an arbitrary method/payload control envelope.

#### Scenario: Valid Pi inspection params
- **WHEN** the control boundary receives Pi Harness identity with optional cwd and refresh
- **THEN** the inspection params schema accepts and preserves only those fields

#### Scenario: Valid Thread Model selection params
- **WHEN** the control boundary receives a non-empty Host Thread ID and valid Harness Model Ref
- **THEN** the Thread selection params schema accepts the request

#### Scenario: Native method is injected
- **WHEN** a control request includes a Pi RPC method name, native Provider/Model fields, or another undeclared property
- **THEN** the method-specific schema rejects the request before Host or Renderer consumes it
