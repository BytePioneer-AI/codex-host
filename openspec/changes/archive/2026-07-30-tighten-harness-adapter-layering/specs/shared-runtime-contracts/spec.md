## MODIFIED Requirements

### Requirement: Shared Model control params are method-specific
Shared Contracts SHALL provide separate strict Runtime Schemas for draft Harness inspection params and current-process Thread Model-selection params, and SHALL NOT provide an arbitrary method/payload control envelope. Harness inspection params SHALL carry a validated opaque Harness ID and MUST NOT be restricted to one concrete Harness.

#### Scenario: Valid registered Harness inspection params
- **WHEN** the control boundary receives a non-empty Harness identity with optional cwd and refresh
- **THEN** the inspection params schema accepts and preserves only those fields

#### Scenario: Valid Thread Model selection params
- **WHEN** the control boundary receives a non-empty Host Thread ID and valid Harness Model Ref
- **THEN** the Thread selection params schema accepts the request

#### Scenario: Native method is injected
- **WHEN** a control request includes a Pi RPC method name, native Provider/Model fields, or another undeclared property
- **THEN** the method-specific schema rejects the request before Host or Renderer consumes it
