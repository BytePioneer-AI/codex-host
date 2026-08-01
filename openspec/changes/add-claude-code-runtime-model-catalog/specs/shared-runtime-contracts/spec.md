## MODIFIED Requirements

### Requirement: Shared Model Catalog contracts remain browser-safe and strict
Shared Contracts SHALL export browser-safe types and Runtime Schemas for opaque Harness Model Refs, normalized Model entries, Model Catalogs, inspection results, structural Model-selection capability, effective selectable Model state, and an optional bounded `resolvedModelLabel` observed from the owning Harness runtime. `resolvedModelLabel` SHALL be display-only and SHALL NOT be accepted as a Model Ref, transport carrier, Provider identity, or setter input. V1 objects SHALL reject undeclared fields at the first formal control-boundary parse.

#### Scenario: Renderer validates a ready inspection
- **WHEN** Renderer receives a ready inspection containing valid opaque Refs, labels, a default Ref, optional resolved Model labels, and Model-selection capability
- **THEN** the public Runtime Schema accepts the complete value without importing Node.js, Electron, a Harness SDK, or another codexhost package

#### Scenario: Renderer validates actual Session Model state
- **WHEN** an owning Adapter publishes one selectable effective Model Ref plus a non-empty bounded runtime-resolved Model label
- **THEN** the Session and Thread state schemas preserve both values without treating the resolved label as a selectable identity

#### Scenario: Inspection leaks native configuration
- **WHEN** a catalog entry or inspection result contains an undeclared Provider object, base URL, price, path, credential, account, or arbitrary native payload
- **THEN** the strict Runtime Schema rejects the value rather than preserving or silently projecting it

#### Scenario: Model Ref is unsuitable for a transport carrier
- **WHEN** a Model Ref is empty, whitespace-only, over the bounded length, or contains characters outside the defined opaque transport-safe alphabet
- **THEN** the Model Ref Runtime Schema rejects it

#### Scenario: Resolved Model label is misused as control input
- **WHEN** a Model selection request carries only a resolved Model label or adds it beside the declared opaque Ref
- **THEN** the method-specific Runtime Schema rejects the request
