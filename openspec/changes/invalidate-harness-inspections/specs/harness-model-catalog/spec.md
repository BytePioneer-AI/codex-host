## ADDED Requirements

### Requirement: Host broadcasts inspection invalidation to local Web catalogs
Host SHALL publish `harness-inspection-changed` with `harnessId` and client-channel cursor after explicit refresh inspection completes, including Codex and normalized failure results. Ordinary inspections SHALL NOT publish this event.

#### Scenario: Explicit refresh finishes
- **WHEN** any Host entry point completes an inspection with `refresh: true`
- **THEN** connected Web clients SHALL invalidate all cwd inspection cache entries for that Harness and emit `codexhost/harness-inspection-changed`
- **AND** the next read SHALL obtain a complete Host inspection rather than a settings-page availability snapshot

#### Scenario: Ordinary reads remain cached
- **WHEN** Web reads the same Harness/cwd without intervening invalidation
- **THEN** Web SHALL reuse the existing pending or completed inspection, including failure states
- **AND** ordinary focus changes and menu opens SHALL NOT bypass the cache or introduce TTL, polling or automatic retries
- **AND** Codex non-ready results SHALL remain uncached

#### Scenario: Host sends hello
- **WHEN** the local Web catalog receives Host hello on initial connection or reconnect
- **THEN** it SHALL clear all inspection and plugin-list cache entries and emit the same browser invalidation event

#### Scenario: Invalidated request finishes late
- **WHEN** an inspection invalidated while in flight later succeeds or fails
- **THEN** it SHALL NOT replace or delete a newer cached request

#### Scenario: Ready catalog changes
- **WHEN** a refreshed Harness remains ready but reports a different Model list
- **THEN** the next local Web catalog read SHALL expose the new Model list

#### Scenario: Local browser receives invalidation
- **WHEN** the selector receives `codexhost/harness-inspection-changed`
- **THEN** it SHALL refresh only its local catalog using the existing refresh concurrency and stale-response protection
- **AND** it SHALL NOT refresh remote Host catalogs
