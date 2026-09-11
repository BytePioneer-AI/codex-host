## MODIFIED Requirements

### Requirement: Session visibility is one-way

codexhost SHALL list and restore DeepSeek Native Sessions as standard Threads only when Mapping Store contains a ready External Thread record. Normal create MAY establish that record for either supported generation. A pre-existing Session MAY enter Mapping Store only after the user invokes the explicit local import flow and Host proves that it is an eligible exact `0.1.2-rc.1` Modern Session. Legacy Sessions, Subagents, blank Sessions and all other unmapped DSH Sessions MUST NOT be claimed as codexhost Thread ownership.

#### Scenario: DSH contains pre-existing Modern Sessions

- **WHEN** the local exact rc.1 profile contains ordinary unmapped history Sessions
- **THEN** eligible Sessions MAY appear only in the explicit settings import page
- **AND** they SHALL remain absent from standard `thread/list` until the user imports one successfully

#### Scenario: User imports one Modern Session

- **WHEN** Host commits one validated ready mapping for the selected Native Session
- **THEN** that Session SHALL appear as exactly one ordinary external Codex Thread
- **AND** every other unmapped DSH Session SHALL remain outside standard Thread ownership

#### Scenario: Legacy DSH is active

- **WHEN** the selected DeepSeek generation is exact `0.1.1-rc.2` Legacy
- **THEN** explicit Session import SHALL be unavailable
- **AND** existing Legacy create and mapped recovery behavior SHALL remain unchanged

#### Scenario: codexhost restarts

- **WHEN** Mapping Store contains created and explicitly imported DeepSeek Native Session references while DSH contains additional Sessions
- **THEN** codexhost SHALL restore only the mapped Sessions through their exact Native IDs
- **AND** it SHALL not automatically enumerate additional DSH Sessions into standard ownership
