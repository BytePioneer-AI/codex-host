## MODIFIED Requirements

### Requirement: DeepSeek Harness uses the shared Adapter contract

The system SHALL provide one public `deepseek-harness` implementation of `HarnessAdapter` and `HarnessSession`. It SHALL use the selected native protocol profile for verified DSH `0.1.2-rc.1`, `0.1.5-rc.1`, `0.1.5-rc.2`, `0.1.5-rc.3`, and `0.1.7-rc.1`; other SemVer runtimes SHALL pass native protocol validation before being reported ready. DSH Remote methods, event names and version profiles MUST remain internal to the Adapter package.

#### Scenario: New DeepSeek Session opens
- **WHEN** Host opens the DeepSeek Adapter with a create input and a runtime whose Web and native protocol checks pass
- **THEN** the Adapter SHALL return a HarnessSession with a stable Native Session reference
- **AND** native resume, same-cwd fork, and last-turn rollback SHALL be available only within the selected profile's verified boundaries

#### Scenario: Runtime exposes a different Session format
- **WHEN** the executable version selects a profile but the native history header or required events use an incompatible format
- **THEN** the Adapter SHALL fail with a protocol error and SHALL NOT report the Session as ready
