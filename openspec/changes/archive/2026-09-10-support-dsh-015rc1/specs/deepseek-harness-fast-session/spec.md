## MODIFIED Requirements

### Requirement: DeepSeek Harness uses the shared Adapter contract

The system SHALL provide one public `deepseek-harness` implementation of `HarnessAdapter` and `HarnessSession` supporting exact DSH `0.1.2-rc.1` and `0.1.5-rc.1`. DSH Remote methods, event names and version profiles MUST remain internal to that Adapter package.

#### Scenario: New DeepSeek Session opens
- **WHEN** Host opens the DeepSeek Adapter with a create input and an exact supported runtime
- **THEN** the Adapter SHALL return a HarnessSession with a stable Native Session reference
- **AND** native resume, same-cwd fork, and last-turn rollback capabilities SHALL be available under the selected profile's verified boundaries

## REMOVED Requirements

### Requirement: Unsupported DeepSeek history mutations are explicit

**Reason**: The early MVP prohibition of Fork and rollback has been replaced by verified native operations in both supported RC versions.

**Migration**: Use the exact checkpoint and replacement requirements in `deepseek-versioned-web-protocol`; unknown operations still fail before mutation.
