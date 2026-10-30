# external-thread-list-archive-routing Specification

## Purpose

Define Metadata-only aggregation, deterministic pagination, and archive management for External Threads in Codex Desktop while preserving official Codex behavior.

## Requirements

### Requirement: Host aggregates official and External Thread lists
Host Runtime SHALL handle `thread/list` as an aggregated operation. It SHALL obtain official Codex rows through the official app-server, obtain External rows from Mapping Store management metadata, apply the current request semantics to both sources, and return one ordered Codex-compatible page without opening any Harness Session.

#### Scenario: Project contains official and External Threads
- **WHEN** Desktop requests a non-archived Thread list whose filters match official Codex and ready External records
- **THEN** Host SHALL return both kinds in one globally sorted page subject to the requested limit
- **AND** every Thread ID SHALL appear at most once

#### Scenario: External runtime is unloaded after restart
- **WHEN** a ready External record matches `thread/list` but has no current-process HarnessSession
- **THEN** Host SHALL return a Metadata-only Thread with empty `turns`, persisted title and ownership fields, and `status.type=notLoaded`
- **AND** it SHALL NOT resume the Adapter or read a Native Snapshot

#### Scenario: External record is not ready
- **WHEN** Store enumeration contains a provisional record without committed Native identity
- **THEN** Host SHALL omit it from the persistent External directory

#### Scenario: One list source fails
- **WHEN** official list execution, official response validation, or Mapping Store enumeration fails
- **THEN** Host SHALL fail the complete `thread/list` request explicitly
- **AND** it SHALL NOT return a partial official-only or External-only success

### Requirement: External list rows obey current filters and metadata boundaries
Host SHALL apply supported `thread/list` filters to External records using only persisted management metadata. It MUST NOT infer values from Native locator data, restore history to obtain Preview, or claim unsupported Codex relationships.

#### Scenario: Archived list is requested
- **WHEN** `archived=true`
- **THEN** Host SHALL include only External records with `archived=true`
- **AND** `archived=false`, null, or omission SHALL include only External records with `archived=false`

#### Scenario: Cwd, Provider, source, and title filters are requested
- **WHEN** the request supplies `cwd`, `modelProviders`, `sourceKinds`, or `searchTerm`
- **THEN** Host SHALL match External rows against persisted cwd, Provider `codexhost`, interactive source `vscode`, and persisted title respectively
- **AND** it SHALL NOT read Transcript content to satisfy a filter

#### Scenario: Parent or ancestor filter is requested
- **WHEN** `parentThreadId` or `ancestorThreadId` is non-null
- **THEN** Host SHALL not treat External Fork lineage as a Codex Subagent relationship
- **AND** it SHALL omit ordinary External records from that filtered result

#### Scenario: Project filter is requested
- **WHEN** `projectId` is a project ID
- **THEN** Host SHALL include only External records whose persisted project assignment equals it
- **AND** `projectId=null` SHALL include only unassigned External records, and omission SHALL include every project

#### Scenario: Legacy pinned rows are requested
- **WHEN** `isPinned=true`
- **THEN** Host SHALL omit External records because the legacy `isPinned` metadata is not an External Pin surface; current Desktop pins through Thread sections
- **AND** when pinned is false, null, or absent, returned External rows SHALL expose `isPinned=false`

#### Scenario: Section filter is requested with timestamp ordering
- **WHEN** `sectionId` is present with `created_at`, `updated_at`, or `recency_at` ordering
- **THEN** Host SHALL include only External records whose section placement matches it, with `null` matching unsectioned records
- **AND** every External row SHALL expose `section` and `sectionEnteredAt` from its placement, or `null` for both

#### Scenario: Unknown filter semantics are received
- **WHEN** a future `thread/list` field could change which External records match and Host cannot safely interpret it
- **THEN** Host SHALL preserve the official list behavior without injecting External rows
- **AND** it SHALL NOT guess a match or reject unrelated official Thread listing solely because of the unknown field

### Requirement: Aggregated list sorting is deterministic
Host SHALL support current `created_at`, `updated_at`, and `recency_at` list ordering in both directions. External rows SHALL use persisted `createdAt` for creation ordering and persisted `updatedAt` for current updated and recency ordering, with stable Host Thread identity as the External tie-breaker.

#### Scenario: Sources share a timestamp
- **WHEN** official and External rows have the same requested sort timestamp
- **THEN** Host SHALL use a documented fixed source tie order
- **AND** repeated requests over unchanged data SHALL return the same global order

#### Scenario: External records share a timestamp
- **WHEN** multiple External rows have the same requested sort timestamp
- **THEN** their Host Thread IDs SHALL provide a stable deterministic order

### Requirement: Aggregated pagination advances both sources without gaps
Host SHALL return versioned opaque `nextCursor` and `backwardsCursor` values that bind the query fingerprint, sort semantics, official opaque position, and External stable anchor. A cursor MUST NOT contain Thread rows, title, cwd, Native Ref, Transcript content, or credentials.

#### Scenario: Both sources span multiple pages
- **WHEN** official and External rows interleave beyond one requested limit
- **THEN** following `nextCursor` until null SHALL return every matching row exactly once in global order
- **AND** neither source SHALL be truncated because the other source filled an earlier page

#### Scenario: One source is exhausted first
- **WHEN** official or External rows have no remaining match
- **THEN** later pages SHALL continue from the remaining source
- **AND** the final page SHALL return `nextCursor=null`

#### Scenario: Sort direction is reversed
- **WHEN** Desktop uses `backwardsCursor` with the opposite sort direction
- **THEN** Host SHALL resume from the page-start boundary using both source positions
- **AND** same-timestamp rows SHALL not be silently skipped

#### Scenario: Cursor belongs to another query
- **WHEN** cursor version, filters, sort key, or cursor direction does not match the request
- **THEN** Host SHALL reject the cursor as invalid
- **AND** it SHALL NOT forward the Host cursor to official Codex

### Requirement: Archive and Unarchive are persisted Host operations
Host Runtime SHALL route `thread/archive` and `thread/unarchive` by persisted Thread ownership. For an External Thread it SHALL update only Mapping Store archive metadata, MUST NOT open or modify the Harness Native Session, and SHALL report success only after the requested state is durable.

#### Scenario: External Thread is archived
- **WHEN** Desktop sends `thread/archive` for a ready External Thread
- **THEN** Host SHALL persist `archived=true`, return the archive response, and then emit `thread/archived` for the same Host Thread ID
- **AND** the Native Session, Transcript, Turn mappings, Fork anchors, and loaded runtime SHALL remain intact

#### Scenario: External Thread is unarchived
- **WHEN** Desktop sends `thread/unarchive` for an archived External Thread
- **THEN** Host SHALL persist `archived=false`, return a Metadata-only Thread with empty `turns`, and then emit `thread/unarchived`
- **AND** the Thread SHALL reappear in matching non-archived lists after restart

#### Scenario: Archive state write fails
- **WHEN** Mapping Store cannot commit the requested archive state
- **THEN** Host SHALL return an explicit error without emitting the success notification
- **AND** the prior list membership SHALL remain authoritative

#### Scenario: Archive request is repeated
- **WHEN** the requested archive state already matches the persisted record
- **THEN** Host SHALL treat the operation as an idempotent success
- **AND** it SHALL preserve response-before-notification ordering without changing Native state

### Requirement: Official Thread management remains transparent
Host SHALL preserve original official Codex behavior for Thread list and management requests that do not target persisted External resources. Internal official list subrequests SHALL use an isolated ID namespace, SHALL be bounded, and SHALL not alter unrelated official responses or notifications.

#### Scenario: Official Thread is archived or unarchived
- **WHEN** the target Thread is not present in External ownership
- **THEN** Host SHALL forward the original request frame to official Codex unchanged
- **AND** it SHALL forward the official response and notifications unchanged

#### Scenario: Official list subrequest completes
- **WHEN** Host receives an internally correlated official list response
- **THEN** Host SHALL consume it only for the pending aggregate request
- **AND** it SHALL emit exactly one final response using the Desktop request ID

#### Scenario: Official app-server exits with pending list work
- **WHEN** the official process exits or Host closes before an internal list response arrives
- **THEN** every pending aggregate request SHALL settle with failure in bounded time

### Requirement: External Desktop metadata updates are persisted Host operations
Host Runtime SHALL handle `thread/metadata/update` for a persisted External Thread as a Host-owned metadata patch. Project assignment, Git metadata, and the Daybreak choice are Desktop organization metadata: Host SHALL persist them only in the Mapping Store, MUST NOT open or modify the Harness Native Session, and SHALL follow current Codex patch semantics (omitted or null leaves a field unchanged, an empty `projectId` clears the assignment, and a null Git field clears that field). Host SHALL respond with the updated Metadata-only Thread, which SHALL expose the persisted `projectId`, `gitInfo`, and `daybreakEnabled`.

#### Scenario: Desktop assigns a new External Thread to a project
- **WHEN** Desktop sends `thread/metadata/update` with a non-empty `projectId` for a ready External Thread
- **THEN** Host SHALL confirm through official `project/read` that the project exists, persist the assignment, return the updated Thread, and then emit `thread/project/updated`
- **AND** the Thread SHALL appear in `thread/list` results filtered by that project after restart

#### Scenario: Harness defers its native Session to the first Turn
- **WHEN** Desktop updates metadata for a loaded External Thread whose record is still provisional because the Harness has not reported native identity
- **THEN** Host SHALL persist the metadata on the provisional record and return the updated Thread
- **AND** committing native identity later SHALL preserve the persisted metadata

#### Scenario: Project is unavailable
- **WHEN** official Codex cannot read the requested project
- **THEN** Host SHALL return an explicit invalid-params error without changing Host state or emitting a notification

#### Scenario: Git metadata or Daybreak choice is patched
- **WHEN** the update includes `gitInfo` fields or `daybreakEnabled`
- **THEN** Host SHALL persist only the supplied fields and return the merged values
- **AND** it SHALL NOT emit `thread/project/updated` when the project assignment is unchanged

#### Scenario: Metadata is updated for a Thread in a section
- **WHEN** Desktop updates metadata for an External Thread with a saved section placement
- **THEN** the response SHALL include that placement in `section` and `sectionEnteredAt`, including after Host restart
- **AND** project filters SHALL apply to External rows in section-ordered lists

#### Scenario: Official Codex deletes a project
- **WHEN** official Codex emits `project/changed` with `changeType=deleted`
- **THEN** Host SHALL forward the notification unchanged, clear every External assignment to that project, and emit `thread/project/updated` with `projectId=null` for each cleared Thread
- **AND** a Thread reassigned to another project before its clear is written SHALL keep the new assignment

### Requirement: External Threads join official Thread sections
Codex Desktop pins and groups Threads through official Thread sections (`thread/section/move`, `thread/list` with `sectionId` and `section_position`). The official app-server owns section definitions and the order of official Threads. Host SHALL persist External section placements in Mapping Store separately from V1 Thread records, and SHALL present one order per section across official and External Threads.

#### Scenario: External Thread is pinned or moved
- **WHEN** `thread/section/move` references an External Thread with a section ID
- **THEN** Host SHALL copy the section definition from official `threadSection/list` and persist the placement before the requested Thread, or last when `beforeThreadId` is null
- **AND** it SHALL answer `{}` without forwarding the External Thread ID to official Codex
- **AND** a missing section or a `beforeThreadId` outside the section SHALL fail with the official `-32600` messages

#### Scenario: External Thread is removed from its section
- **WHEN** `thread/section/move` references an External Thread with `sectionId: null`
- **THEN** Host SHALL remove its placement, and later reads SHALL expose `section: null` and `sectionEnteredAt: null`

#### Scenario: Official Thread is moved relative to External Threads
- **WHEN** `thread/section/move` references an official Thread while External placements exist or `beforeThreadId` names an External Thread
- **THEN** Host SHALL forward an official move whose `beforeThreadId` is the next official Thread in the intended order
- **AND** after the official move succeeds, Host SHALL re-anchor affected External placements so the merged order equals the intended order

#### Scenario: Official move touches no External placement
- **WHEN** no External placement exists and `beforeThreadId` does not name an External Thread
- **THEN** Host SHALL forward the original frame to official Codex unchanged

#### Scenario: Section order is listed
- **WHEN** `thread/list` uses `section_position` with a string `sectionId` and a listed External Thread is placed in that section
- **THEN** Host SHALL merge External rows into the complete official section order, apply the requested direction (ascending by default), and paginate with a Host section cursor bound to the query
- **AND** when no listed External Thread is placed there, or the request continues an official cursor, Host SHALL forward the original frame unchanged

#### Scenario: Placement storage is unreadable or outlives its Thread
- **WHEN** the placement file is invalid, or a placement references a removed Thread or an anchor that left the section
- **THEN** Host SHALL quarantine the invalid file without blocking Thread access, ignore placements of removed Threads, and keep an orphaned placement last in its section

### Requirement: Unsupported External metadata changes fail closed
A current or future management request that references a persisted External Thread MUST be handled by a supported Host operation or fail explicitly. It MUST NOT fall through to official Codex merely because Host does not support that metadata field.

#### Scenario: Unsupported metadata field is requested
- **WHEN** `thread/metadata/update` references an External Thread and includes a field outside the current Codex metadata contract, such as the retired `isPinned` or an unknown key inside `gitInfo`
- **THEN** Host SHALL return explicit unsupported naming each such field
- **AND** it SHALL apply none of the request's fields and SHALL not forward the External Thread ID to official Codex

#### Scenario: Official metadata update is requested
- **WHEN** `thread/metadata/update` references no persisted External Thread
- **THEN** Host SHALL forward the original frame to official Codex unchanged
