## ADDED Requirements

### Requirement: Settings exposes a local DSH Modern Session Import page

The production settings registry SHALL expose one localized Session Import page between Connections and Updates. The page SHALL use only fixed DSH Modern list/import client methods routed to the local Host, regardless of the active Composer Host. It SHALL report unavailable when the local request bridge is absent, DeepSeek is unavailable, or the selected DeepSeek generation is not exact `0.1.2-rc.1` Modern. It MUST NOT expose Legacy or another Harness import, Remote Host import, a generic request bridge, filesystem access, credentials or a second modal.

#### Scenario: Local Modern import is available

- **WHEN** the local Host owns a ready exact rc.1 Modern Adapter
- **THEN** the page SHALL list its eligible unmapped Session candidates without changing Agent, Model, Composer or Thread routing state
- **AND** opening the page MAY initialize only the same managed Adapter lifecycle used by local Harness inspection

#### Scenario: Current Composer uses a Remote Host

- **WHEN** settings opens while the active Composer is routed to SSH or another Remote Host
- **THEN** Session Import SHALL still request only `modelClientForHost("local")`
- **AND** absence of that local client SHALL produce an honest unavailable state instead of sending the request remotely

#### Scenario: Legacy or another Harness is active

- **WHEN** local DeepSeek selection resolves to Legacy or the user selects another Harness in a Composer
- **THEN** the page SHALL not offer a successful import operation for that generation or Harness
- **AND** all existing Harness and Composer behavior SHALL remain unchanged

### Requirement: Session Import presentation is compact and accessible

The page SHALL provide a heading, one short description, Refresh, and a compact candidate list. Each row SHALL present a localized title fallback, update time, cwd, short Native Session identity, momentary running state and at most one primary “Import and open” action. Running rows SHALL remain visible but disabled. Blank, Subagent and already-mapped Sessions SHALL not be displayed.

#### Scenario: List is loading, unavailable, empty or failed

- **WHEN** the fixed list operation is pending, unavailable, returns no eligible candidates or fails
- **THEN** the page SHALL show the matching localized accessible state
- **AND** failure SHALL offer one Refresh action without inventing Session data

#### Scenario: Candidate list is ready

- **WHEN** Host returns idle and running eligible rows
- **THEN** the page SHALL preserve Host order and render only their bounded metadata
- **AND** idle rows SHALL allow import while running rows explain that the user can stop activity and refresh

#### Scenario: Narrow window displays candidates

- **WHEN** settings uses its narrow layout or a candidate contains a long cwd
- **THEN** metadata SHALL remain readable without page-level horizontal overflow or overlapping the action
- **AND** keyboard focus and complete accessible text SHALL remain available

### Requirement: Import operations are current, single-flight and open the exact local Thread

The page SHALL use its existing page scope and latest-result generation for list/import work. Navigation, close, locale remount, Refresh and disposal MUST prevent stale results from mutating the current page or opening a Thread. One candidate SHALL have at most one import request in flight. A current success SHALL close settings and use the shared Host-qualified sidebar opener to open only the returned local Host Thread ID.

#### Scenario: User imports an idle candidate

- **WHEN** one current import returns a valid Host Thread ID and its standard local sidebar row appears
- **THEN** settings SHALL open exactly that Thread
- **AND** first history loading SHALL proceed through the standard notLoaded Thread path

#### Scenario: User activates import repeatedly

- **WHEN** an import request is already pending
- **THEN** the candidate action and Refresh SHALL remain disabled as appropriate
- **AND** Renderer SHALL not send a duplicate request for that operation

#### Scenario: Result becomes stale

- **WHEN** the page is closed, replaced, remounted or refreshed before a list/import/navigation result settles
- **THEN** the stale result SHALL not update the current page or open an unrelated Thread
- **AND** any already committed mapping MAY remain visible through the standard sidebar

#### Scenario: Sidebar navigation times out after commit

- **WHEN** Host committed and returned the mapping but its matching local sidebar row is not found within the bounded wait
- **THEN** Renderer SHALL clean up its observer/timer and leave the imported Thread available to the next standard sidebar/list refresh
- **AND** it SHALL not retry import, delete the mapping or click a row belonging to another Host
