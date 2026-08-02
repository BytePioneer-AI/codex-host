## MODIFIED Requirements

### Requirement: Claude text streaming has one complete ordered lifecycle

Every accepted Claude text Turn SHALL emit one Turn start, one Agent Message start, ordered non-duplicated text append updates, one Item terminal, and one Turn terminal. Partial and complete Assistant text SHALL be reconciled within the native Assistant response that produced them; complete text from a later response in the same Tool loop SHALL NOT be treated as a cumulative snapshot of the Host Turn. Unknown native message types and non-text content MUST NOT cross the HarnessAdapter seam.

#### Scenario: Partial text and full Assistant agree

- **WHEN** SDK partial events stream a text prefix and the complete Assistant message for that response contains the prefix plus a suffix
- **THEN** the Adapter SHALL append each character exactly once
- **AND** it SHALL append only the missing suffix from the complete message

#### Scenario: Streaming is unavailable

- **WHEN** no partial text event is emitted but a complete Assistant text message arrives
- **THEN** the Adapter SHALL publish that complete text once before the Item terminal

#### Scenario: Tool loop has text before and after a permission decision

- **WHEN** one Host Turn contains an Assistant text response, a Tool permission callback and result, and a later Assistant text response before the native Turn Result
- **THEN** the Adapter SHALL reconcile each complete response only with partial text emitted for that response
- **AND** it SHALL append both responses in order exactly once without reporting a text conflict merely because the later response omits earlier Turn text

#### Scenario: Native text conflicts

- **WHEN** a complete Assistant text cannot be reconciled with partial text already emitted for the same open native response
- **THEN** the Item and Turn SHALL fail exactly once
- **AND** the Adapter SHALL NOT replay or replace the visible text silently
