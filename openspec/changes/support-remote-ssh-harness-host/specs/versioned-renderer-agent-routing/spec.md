## MODIFIED Requirements

### Requirement: Renderer routing SHALL bind Agent selection to the active Codex host

The versioned Renderer Adapter SHALL bind Agent selection and draft prewarm routing to the currently active non-empty Codex host ID and the current Composer's scoped draft-or-Thread identity. It SHALL reconcile the installed policy when the active bridge or host changes and SHALL preserve the selected carrier across that reconciliation. An empty host ID or ambiguous Composer identity SHALL be rejected.

#### Scenario: Active composer moves to an SSH host

- **WHEN** the Renderer already has an installed local draft policy and the active composer changes to a remote host ID
- **THEN** the Adapter replaces the policy with one owned by the remote bridge and host ID
- **AND** re-applies the selected Harness carrier to the remote active request manager

#### Scenario: Active bridge and host remain unchanged

- **WHEN** reconciliation observes the same bridge and host ID
- **THEN** the existing policy remains installed
- **AND** the selected carrier is not reset

#### Scenario: New remote Composer has an unrelated ancestor conversation

- **GIVEN** the remote project surface contains a background conversation ID outside the active Composer
- **WHEN** the active Composer's scoped portal omits its conversation attribute and exposes exactly one validated `client-new-thread` draft
- **THEN** the Adapter identifies the model target as that draft
- **AND** the unrelated ancestor conversation does not lock Agent selection

#### Scenario: Remote Composer binds its draft to a Thread

- **WHEN** the active Composer's scoped portal exposes a validated conversation ID after submission
- **THEN** that conversation ID becomes the authoritative model target
- **AND** a retained draft settings wrapper does not make the bound Composer ambiguous
