## ADDED Requirements

### Requirement: Production Host registers local DSH Host routing
The production composition root SHALL register DeepSeek Harness through its local DSH Host Adapter configuration. Availability SHALL mean that a compatible configured Host is reachable or a configured local DSH Web command can be started; it MUST NOT mean that a codexhost-owned private runtime is bundled.

#### Scenario: Existing local DSH Host is available
- **WHEN** Host Runtime inspects DeepSeek Harness and the configured loopback DSH Host is compatible
- **THEN** inspection SHALL report the local Host's model catalog as ready
- **AND** valid DeepSeek transport carriers SHALL be routable through the existing external Thread path

#### Scenario: Local DSH command and Host are absent
- **WHEN** no compatible endpoint is reachable and no configured local DSH command can be resolved
- **THEN** DeepSeek Harness inspection SHALL report not installed or unavailable explicitly
- **AND** Codex, Pi, and Claude Code routing SHALL remain unchanged

### Requirement: DeepSeek ownership remains mapping-driven
Host Runtime SHALL persist each codexhost-created DSH Native Session reference through the generic external Thread mapping path and SHALL use only those records for codexhost ownership, resume, and list operations.

#### Scenario: Official DSH has unrelated Sessions
- **WHEN** ownership or Thread list is requested while DSH contains Sessions absent from Mapping Store
- **THEN** Host Runtime SHALL ignore those Sessions without opening or importing them
- **AND** it SHALL continue to report mapped DeepSeek Threads as `deepseek-harness`

### Requirement: Composition no longer packages a private DSH runtime
Release composition and audit SHALL include the DeepSeek Adapter's official Host client dependencies but SHALL exclude the deleted codexhost Cordis runtime, bridge, and private DSH Session-root configuration.

#### Scenario: Host release bundle is audited
- **WHEN** the production Host release bundle is built
- **THEN** it SHALL resolve the DeepSeek local Host client and Adapter
- **AND** it SHALL NOT require `runtime/cordis.yml`, `runtime/server.mjs`, or `dsh-jsonrpc-agent`
