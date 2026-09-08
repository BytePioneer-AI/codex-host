# harness-session-import Specification

## Purpose

定义由公共 Adapter 驱动、按当前 Host 隔离的原生 Session 导入。Claude Code、Pi 与 DSH Modern 共用 Host/RPC/Renderer 流程；本规范扩展原 DeepSeek 导入页面的单 Harness 范围，但不放宽 DSH Modern 的运行时限定。

## Requirements

### Requirement: Adapter owns native discovery and resumable identity

Adapter SHALL use `sessionImport.listCandidates()` to return bounded browser-safe metadata and `resolveCandidate(nativeSessionId)` to revalidate a selected Session and return its complete `NativeSessionRef`. Host SHALL NOT infer native locators or accept them from Renderer. A discovery-only Adapter without a resolver SHALL remain loadable but SHALL NOT be advertised as importable.

#### Scenario: Pi needs a file locator

- **WHEN** Pi resolves an eligible native Session
- **THEN** the returned reference SHALL include its exact `locator.sessionFile`
- **AND** Host SHALL persist that reference without copying native Transcript content

#### Scenario: Candidate changes after listing

- **WHEN** a listed Session disappears, becomes busy, or its metadata changes
- **THEN** import SHALL use fresh Adapter resolution rather than browser-supplied metadata
- **AND** missing or known-busy Sessions SHALL NOT create a ready mapping

### Requirement: Host owns an idempotent mapping-only transaction

Host SHALL deduplicate by Harness and native Session identity, coalesce concurrent requests, preserve provisional-to-ready persistence and failure cleanup, and reuse the winner of a unique-identity race. Import SHALL NOT create an official shadow Thread, send a Turn, convert history to another Harness, or start a Pi Agent process.

#### Scenario: Two Harnesses use the same native ID

- **WHEN** Pi and DSH resolve the same native Session ID string
- **THEN** their imports SHALL create separate Harness-owned mappings

#### Scenario: Duplicate import or failed navigation

- **WHEN** the same Session is imported again, including through a legacy DSH alias or after failed navigation
- **THEN** Host SHALL return the existing ordinary ready Thread ID
- **AND** navigation failure SHALL NOT delete the committed mapping

#### Scenario: Imported Pi Thread is opened and continued

- **WHEN** the imported Thread is opened
- **THEN** Pi SHALL resume the persisted native file and project its active-branch history
- **AND** subsequent Turns SHALL continue that same native Session rather than create an empty replacement

### Requirement: Pi discovery follows supported native storage rules

Pi SHALL discover v3 JSONL Sessions in the default per-project agent storage or the configured flat Session directory. Discovery SHALL be read-only, streaming, cancellable, and reject ambiguous native identities. Pi SHALL NOT impose fixed storage-byte, file-count, Entry-count or total-candidate ceilings. Missing roots MAY produce an empty list; permission and identity ambiguity failures SHALL NOT masquerade as empty storage. A Session changing during list discovery MAY be omitted until a later refresh, but MUST be revalidated before import.

#### Scenario: Native data is not safely resumable

- **WHEN** a file is malformed, an older format, lacks a user message on the active branch, has invalid Entry ancestry, or references a missing project
- **THEN** Pi SHALL omit it without modifying or migrating it

#### Scenario: Native activity cannot be observed

- **WHEN** Pi cannot reliably determine whether another process still owns a Session
- **THEN** its candidate SHALL report `running: null`, never false
- **AND** Renderer SHALL show unknown activity and instruct the user to close the native client before importing
- **AND** the implementation SHALL NOT claim exclusive ownership or cross-process locking

### Requirement: Claude discovery uses native resumable metadata in every supported Host mode

Claude Code SHALL discover native Sessions through the Claude Agent SDK across projects, including recoverable SDK-origin Sessions, reject invalid or missing project directories and re-query a selected identity before import. It SHALL NOT copy Transcript content or manufacture a native file locator. Direct adapters and the macOS Aqua Broker SHALL expose equivalent import capability on the target Host; Broker transport SHALL page bounded metadata without imposing a total candidate ceiling.

#### Scenario: Claude activity cannot be observed across processes

- **WHEN** the target Claude Session is not open through the current Adapter but may be open in another native client
- **THEN** its candidate SHALL report `running: null`, never false
- **AND** a Session open through the current Adapter SHALL report `running: true`

#### Scenario: Managed remote macOS Host imports Claude

- **WHEN** Session Import targets a managed remote macOS Host
- **THEN** discovery and fresh resolution SHALL execute through the owner-only Aqua Broker
- **AND** only browser-safe metadata and the validated native reference SHALL cross the Broker
- **AND** the imported Thread SHALL resume that same remote native Claude Session

### Requirement: Generic Session lists support search and configurable pagination

Host SHALL filter ordinary mapped Sessions and search all candidate titles, native IDs and project paths case-insensitively before sorting and paging. The generic list RPC SHALL accept optional `query`, `offset` and `limit`, and return `{ candidates, total }`. The default page size SHALL be 20; Renderer SHALL offer 20/50/100, previous/next navigation and the filtered total. A wire page bound SHALL NOT limit total native storage.

#### Scenario: Search result is outside the displayed page

- **WHEN** a matching Session is not in the current page
- **THEN** submitting a search SHALL still find it and reset the offset to zero
- **AND** late responses from previous searches SHALL NOT overwrite the current results

#### Scenario: Browsing large unchanged Pi storage

- **WHEN** a user flips pages or searches after first discovery
- **THEN** Pi SHALL reuse unchanged file metadata rather than reread every Transcript
- **AND** changed and removed files SHALL invalidate the corresponding metadata
- **AND** import SHALL freshly validate the selected file, not trust cached eligibility

#### Scenario: A last page disappears after filtering or refresh

- **WHEN** the requested offset exceeds the new result count
- **THEN** Renderer SHALL return to a valid page rather than leave the user stuck on an empty page

### Requirement: Renderer uses fixed Host-scoped generic APIs

Renderer SHALL obtain import sources from the current Composer Host and use strict fixed sources/list/import RPCs. Source availability SHALL be distinguished from current native protocol availability. A displayed list, its import request and imported Thread navigation SHALL remain fixed to the same captured Host. Harness switching or page disposal SHALL invalidate stale results and prevent stale navigation.

#### Scenario: Composer is on a remote Host

- **WHEN** the user opens Session Import while Composer targets a remote Host
- **THEN** discovery, import and imported Thread navigation SHALL use that remote Host
- **AND** native paths and mappings SHALL remain remote rather than leaking into the local Host

#### Scenario: Unsupported runtime or older Host

- **WHEN** the current native protocol does not support import, or the Host lacks the generic RPCs
- **THEN** the page SHALL display an explicit unavailable state without exposing raw native errors or using an arbitrary request bridge
