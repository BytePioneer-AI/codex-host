## MODIFIED Requirements

### Requirement: Renderer applies Claude mode changes through the owning Session

A Claude draft selection SHALL update the provider preference and its bounded request-local carrier. An Existing Thread selection SHALL call only `codexhost/thread/permission-mode/select`, then apply the current catalog mode returned by Host. Native rejection SHALL leave the Thread on its prior current mode and show an ordinary selection error; it SHALL NOT fault the Renderer or route the Thread to Codex. Because the picker label returns to the prior mode, a rejected selection SHALL also show a visible failure mark on the picker trigger until the next successful selection or refresh, and the rejection reason SHALL remain available in the trigger tooltip and accessible label.

#### Scenario: Existing Claude mode changes successfully

- **WHEN** Host returns a selectable current mode after the owning SDK setter completes
- **THEN** Renderer SHALL update the picker and carrier to that returned mode

#### Scenario: Native mode selection fails

- **WHEN** Host reports an SDK rejection such as model-ineligible `auto`
- **THEN** the Existing Thread SHALL retain its prior mode and remain usable
- **AND** the provider preference SHALL remain the user's last selected default for future Claude drafts
- **AND** the picker trigger SHALL show a visible failure mark with the Host-reported reason in its tooltip and accessible label
