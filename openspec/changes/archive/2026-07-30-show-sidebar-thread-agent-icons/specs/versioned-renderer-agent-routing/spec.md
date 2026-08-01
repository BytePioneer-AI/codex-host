## ADDED Requirements

### Requirement: Supported sidebar rows show immutable external Agent ownership
For a supported Desktop build, Renderer Extension SHALL recover each mounted sidebar row's Host Thread ID only from a bounded React Fiber chain where one or more equal `conversationId` props have `dataAttributes` matching that exact DOM row's task-key, host, and row-marker attributes. It SHALL NOT treat the opaque sidebar task key as a Host Thread ID. Renderer SHALL batch validated Host Thread IDs through the fixed ownership-list client and render a compact title-prefix icon for a known external Agent. Codex rows SHALL remain unchanged, and sidebar decoration SHALL NOT alter Thread routing, selection, rename, status, pin, archive, hover, or action behavior.

#### Scenario: Pi and Claude Code rows are mounted
- **WHEN** mounted sidebar rows belong to Pi and development-gated Claude Code Threads
- **THEN** Renderer SHALL display the reviewed Pi and Claude Code icons before their respective titles
- **AND** each icon SHALL provide the Agent label without intercepting pointer input

#### Scenario: Codex row is mounted
- **WHEN** Host reports Codex ownership for a mounted sidebar row
- **THEN** Renderer SHALL leave the row undecorated

#### Scenario: Ownership lookup is unavailable or malformed
- **WHEN** the row/Fiber association is missing or ambiguous, the fixed request manager is unavailable, Host rejects the request, the response does not exactly match requested IDs, or the Harness has no known icon
- **THEN** Renderer SHALL leave affected rows undecorated and SHALL NOT infer ownership from title, Model Provider, Subagent fields, ordering, or timing

### Requirement: Sidebar ownership decoration survives virtualized row lifecycle
Renderer SHALL cache successful immutable ownership by Host Thread ID, coalesce DOM scans, and revalidate row connectivity plus its exact DOM/Fiber-derived Host Thread ID before applying asynchronous results. It SHALL remove or replace owned decoration when React replaces title content, recycles a row for another Thread, or the extension is disposed.

#### Scenario: Row is reused before ownership resolves
- **WHEN** a mounted row changes from one Thread ID to another before the earlier ownership request completes
- **THEN** Renderer SHALL NOT apply the earlier Thread's Agent icon to the reused row

#### Scenario: React replaces the row title DOM
- **WHEN** an externally owned row remains mounted but its title subtree is replaced
- **THEN** Renderer SHALL restore exactly one matching Agent icon from cached ownership

#### Scenario: Renderer Extension is disposed
- **WHEN** the Renderer Binding Probe is disposed
- **THEN** it SHALL disconnect sidebar observation, remove owned Agent icons, and ignore pending ownership results
