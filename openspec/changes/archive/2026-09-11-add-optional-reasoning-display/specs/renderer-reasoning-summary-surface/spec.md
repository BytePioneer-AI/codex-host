## ADDED Requirements

### Requirement: Renderer provides an optional external Reasoning summary surface

Renderer SHALL offer a persisted boolean preference for showing explicit external Harness Reasoning summaries. The preference SHALL default to disabled. While enabled, Renderer SHALL validate the native summary notification lane, confirm that the Thread owner is external, and display the current Thread's exact summary text in a collapsible plain-text panel. It SHALL NOT display native Codex reasoning, arbitrary Item content, encrypted or redacted fields, signatures, inferred text, or unknown payload fields.

#### Scenario: User enables reasoning summaries for an external Thread

- **WHEN** the preference is enabled and an externally owned Thread emits validated summary deltas
- **THEN** Renderer SHALL show those deltas exactly once in arrival order
- **AND** the panel SHALL remain expanded and scrollable while the Reasoning Item is live

#### Scenario: External Reasoning completes

- **WHEN** the live Reasoning Item emits a validated completion summary
- **THEN** Renderer SHALL use that explicit summary as the completed plain-text content
- **AND** the panel SHALL collapse by default while remaining manually expandable

#### Scenario: Reasoning display is disabled

- **WHEN** the preference is absent, false, or changed from true to false
- **THEN** Renderer SHALL attach no ongoing Reasoning notification subscription or DOM observer
- **AND** it SHALL remove any panel, queued event, ownership result, and in-memory Reasoning text

#### Scenario: Reasoning payload contains private or unrelated fields

- **WHEN** a notification includes `content`, encrypted/redacted data, signatures, a non-reasoning Item, or an unrecognized method
- **THEN** Renderer SHALL ignore those fields or the entire notification as applicable
- **AND** none of that content SHALL appear in DOM, persistence, diagnostics, or logs

#### Scenario: Thread ownership is native Codex or unavailable

- **WHEN** fixed Thread inspection reports Codex ownership or cannot prove external ownership
- **THEN** Renderer SHALL render no custom Reasoning panel for that Thread
- **AND** the native Codex presentation SHALL remain unchanged

#### Scenario: Active Host route changes during ownership inspection

- **WHEN** the request manager or active Host policy changes before a queued ownership inspection completes
- **THEN** Renderer SHALL invalidate the old notification source, ownership result, queued summary, and visible panel
- **AND** a late callback or inspection result from the old route SHALL NOT affect the replacement route

#### Scenario: Ownership inspection hangs or pending output exceeds its limit

- **WHEN** fixed ownership inspection does not complete within the bounded timeout or its coalesced pending summary exceeds the bounded text limit
- **THEN** Renderer SHALL fail closed and discard that Thread's pending summary for the current route
- **AND** it SHALL NOT retain an unbounded event queue or render partial unverified text
