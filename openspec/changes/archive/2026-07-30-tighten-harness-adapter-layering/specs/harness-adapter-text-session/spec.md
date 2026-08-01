## ADDED Requirements

### Requirement: Native Session identity publication is fail-closed
A concrete Adapter SHALL publish a Native Session Ref only when the native Harness has provided or accepted a stable Session identity. An Adapter MUST NOT synthesize a fallback identity when required native state omits or invalidates that identity.

#### Scenario: Native protocol omits Session identity
- **WHEN** a Native Session state response lacks a non-blank stable Session identity
- **THEN** the Adapter SHALL return or emit a normalized protocol failure
- **AND** it SHALL NOT publish or persist a generated Native Session Ref

#### Scenario: Adapter assigns an identity accepted by the Harness
- **WHEN** an official Harness interface accepts a caller-assigned Session identity and uses it for persisted native history
- **THEN** the Adapter MAY publish that confirmed identity
- **AND** repeated Turn identities for that Session SHALL continue to reference the same Native Session identity
