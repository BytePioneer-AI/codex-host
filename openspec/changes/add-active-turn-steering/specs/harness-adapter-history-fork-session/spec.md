## ADDED Requirements

### Requirement: Steered native segments preserve one logical Host Turn

Every completed persisted Host Turn SHALL expose a stable `NativeTurnRef` for restart alignment. A Harness MAY represent one Host Turn with multiple native user/assistant segments when the additional segments were accepted through active-Turn steering. In that case the Adapter SHALL return all ordered user inputs and Items as one snapshot Turn, SHALL use the root native segment as its stable Native Turn identity, and SHALL use only the final segment terminal as the Turn Checkpoint and outcome. Intermediate native segment terminals SHALL NOT be exposed as Host Turn Fork boundaries. A Session that reports `history.fork=true` SHALL expose a `NativeCheckpointRef` only when the native system can derive an independent continuation ending exactly at that logical Turn boundary.

#### Scenario: Stable identities survive restart

- **WHEN** Host resumes a Native Session and reads the same completed history
- **THEN** each logical Turn SHALL retain a stable Native Turn identity and final Checkpoint
- **AND** a steered Turn SHALL not split into multiple Host Turns after restart

#### Scenario: Intermediate steering checkpoint is not forkable

- **WHEN** a native assistant terminal is followed by another accepted steering segment in the same Host Turn
- **THEN** the earlier assistant identity SHALL NOT resolve as a Host Turn Fork boundary
- **AND** only the final assistant terminal MAY be exposed as that Turn's Checkpoint
