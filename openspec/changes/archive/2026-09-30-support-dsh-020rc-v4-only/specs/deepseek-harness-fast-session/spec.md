## MODIFIED Requirements

### Requirement: DeepSeek Harness uses the shared Adapter contract

The system SHALL provide one public `deepseek-harness` implementation of `HarnessAdapter` and `HarnessSession`. It SHALL use the single V4 native protocol profile for verified DSH `0.1.7-rc.1`, `0.1.7-rc.2`, `0.2.0-rc.1`, and `0.2.0-rc.2`. Other SemVer runtimes at or above `0.1.7-rc.1` SHALL pass native protocol validation before being reported ready; runtimes below `0.1.7-rc.1` SHALL be rejected as unsupported before the managed Web starts. DSH Remote methods, event names and the protocol profile MUST remain internal to the Adapter package.

#### Scenario: New DeepSeek Session opens
- **WHEN** Host opens the DeepSeek Adapter with a create input and a runtime whose Web and native protocol checks pass
- **THEN** the Adapter SHALL return a HarnessSession with a stable Native Session reference
- **AND** native resume, same-cwd fork, and last-turn rollback SHALL be available only within the V4 profile's verified boundaries

#### Scenario: Runtime exposes a different Session format
- **WHEN** the executable version is supported but the native history header or required events are not V4
- **THEN** the Adapter SHALL fail with a protocol error and SHALL NOT report the Session as ready

#### Scenario: Runtime is older than the V4 line
- **WHEN** the executable reports a normative SemVer version below `0.1.7-rc.1`
- **THEN** inspection and open SHALL fail with `unsupported` and an upgrade instruction
- **AND** the Adapter SHALL NOT start the managed Web or open any Session
