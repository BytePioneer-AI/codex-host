## ADDED Requirements

### Requirement: Explicit Modern import reuses the existing ready mapping transaction

Host SHALL persist an explicitly imported DSH Modern Session only through the existing Mapping Store provisional and ready APIs. The resulting record SHALL use the existing V1 Schema and Native Session uniqueness rule, contain only External Thread management metadata and zero initial Turn mappings, and remain discoverable through the Store's current in-memory indexes without restart. Renderer MUST NOT create or edit Mapping Store files directly.

#### Scenario: Mapping-only import commits

- **WHEN** Host imports one freshly validated Modern Session
- **THEN** Mapping Store SHALL atomically transition one provisional record to ready with the exact DeepSeek Native Session Ref
- **AND** the final threads directory SHALL contain one ordinary V1 record without Transcript content or a Schema extension

#### Scenario: Two requests target one Native Session

- **WHEN** duplicate or concurrent import requests address the same Harness and Native Session identity
- **THEN** Host single-flight, idempotent lookup and the Store's unique Native Session index SHALL expose at most one ready owner
- **AND** any losing provisional record SHALL remain removable

#### Scenario: Process exits before ready commit

- **WHEN** codexhost terminates after provisional creation but before committing a Native Session Ref
- **THEN** existing Mapping Store initialization recovery SHALL remove that incomplete record
- **AND** no DSH Native data SHALL be modified as compensation

#### Scenario: Mapping is ready but Session opening later fails

- **WHEN** ready commit completed and a later sidebar navigation or Standard Thread resume fails
- **THEN** Mapping Store SHALL retain the valid ready record
- **AND** import UI code SHALL not delete it or create a replacement mapping
