## MODIFIED Requirements

### Requirement: Renderer routing SHALL bind Agent selection to the active Codex host

The versioned Renderer Adapter SHALL bind Agent selection and draft prewarm routing to the currently active non-empty Codex host ID. It SHALL reconcile the installed policy when the active bridge or host changes and SHALL preserve the selected carrier across that reconciliation. An empty host ID SHALL be rejected.

#### Scenario: Active composer moves to an SSH host

- **WHEN** the Renderer already has an installed local draft policy and the active composer changes to a remote host ID
- **THEN** the Adapter replaces the policy with one owned by the remote bridge and host ID
- **AND** re-applies the selected Harness carrier to the remote active request manager

#### Scenario: Active bridge and host remain unchanged

- **WHEN** reconciliation observes the same bridge and host ID
- **THEN** the existing policy remains installed
- **AND** the selected carrier is not reset
