## ADDED Requirements

### Requirement: Contract audit SHALL be local developer tooling only
The repository SHALL provide a local Codex Desktop contract-audit command that is not invoked by production Launcher startup, Controller readiness, Host runtime composition, Renderer production entry, or user-facing update operations. Audit findings MUST NOT display compatibility dialogs, write compatibility acknowledgements, or block normal managed Desktop startup.

#### Scenario: User starts codexhost normally
- **WHEN** the production Launcher starts or attaches to a managed Desktop
- **THEN** the contract-audit command SHALL NOT run
- **AND** no audit report or baseline SHALL be required for startup

#### Scenario: Maintainer invokes the audit command
- **WHEN** a maintainer explicitly runs the local audit command
- **THEN** the command SHALL inspect the requested local Desktop endpoints and write only local ignored evidence
- **AND** it SHALL NOT modify production readiness or user compatibility policy

### Requirement: Read-only inspection SHALL be the default mode
The audit command SHALL default to read-only inspection of caller-provided loopback CDP and Electron Inspector endpoints. In read-only mode it MUST NOT reload a Renderer, install production policies, inject the Renderer bundle, switch Agent state, submit a Composer, create or delete a Thread, open Settings, or modify the installed application.

#### Scenario: Audit runs without a controlled flag
- **WHEN** the maintainer supplies reachable loopback CDP and Inspector endpoints without enabling controlled mode
- **THEN** the audit SHALL evaluate only side-effect-free metadata and Renderer inspection expressions
- **AND** the report SHALL identify every behavior boundary that was not exercised

#### Scenario: Endpoint is not loopback
- **WHEN** either endpoint resolves to a non-loopback HTTP host or an invalid port
- **THEN** the command SHALL reject the request before opening a connection

### Requirement: Audit SHALL inventory every codexhost-consumed GUI surface
The MVP audit SHALL classify semantic contracts for Composer identity and actions, Model target, Permission control, request/prewarm ownership, title policy, Settings insertion, Sidebar decoration, Usage/Credits placement, and Fork discovery. Each surface result SHALL include stable contract identifiers, observed state, bounded cardinality or ownership evidence, checks that ran, and a stable reason code.

#### Scenario: Active Composer exposes all core routing contracts
- **WHEN** the primary Renderer contains one active supported Composer and the required request and title ownership objects are observable
- **THEN** the report SHALL include Composer, Model, Permission, request/prewarm, and title results
- **AND** each result SHALL distinguish unique, missing, ambiguous, unsupported, and state-inactive outcomes

#### Scenario: Conditional surface is not active
- **WHEN** Fork, Permission, Usage, Credits, Sidebar, or Settings evidence is unavailable because its documented UI precondition is not active
- **THEN** the surface SHALL be `unverified` rather than `confirmed-impact`
- **AND** the report SHALL identify the unavailable precondition without recording user content

### Requirement: Audit discovery SHALL reuse owning production contracts
Private selectors, React/Fiber shape discovery, request-manager shape validation, and main-process ownership checks used by the audit SHALL remain owned by the production module that consumes that contract. The audit runner MUST NOT maintain a parallel copy of those assumptions.

#### Scenario: Production Settings anchor changes
- **WHEN** the owning Settings module changes its reviewed header-surface discovery contract
- **THEN** read-only audit inspection SHALL consume the same owning discovery logic or normalized inspector
- **AND** the CLI runner SHALL not require a second selector edit

#### Scenario: Audit reads a private object
- **WHEN** inspection traverses a Fiber, request manager, or main-process service
- **THEN** the owning inspector SHALL return only normalized state, cardinality, API-shape, and ownership evidence
- **AND** it SHALL omit object values, function source, IDs, payloads, and text content

### Requirement: Audit SHALL report evidence levels and per-surface verdicts
Each surface SHALL report applicable `static`, `liveStructure`, `installation`, and `behavior` evidence separately. The audit SHALL use only `no-impact`, `confirmed-impact`, `possible-impact`, or `unverified` as compatibility verdicts and MUST NOT infer behavior success from static markers or installation status alone.

#### Scenario: Structure and observed installation agree
- **WHEN** a required active surface has unchanged normalized baseline evidence, unique live ownership, and a successful applicable installation check
- **THEN** that surface MAY be `no-impact`
- **AND** the report SHALL still identify any behavior boundary that was not exercised

#### Scenario: Expected active ownership is ambiguous
- **WHEN** a required active contract resolves to multiple candidate owners or an explicitly controlled behavior fails
- **THEN** the affected surface SHALL be `confirmed-impact`
- **AND** the command SHALL exit non-zero after writing the sanitized report

#### Scenario: Material evidence changed without a decisive live state
- **WHEN** normalized baseline evidence changes materially but the required UI state or controlled boundary is unavailable
- **THEN** the affected surface SHALL be `possible-impact`
- **AND** the report SHALL state what evidence is needed to resolve the verdict

### Requirement: Audit evidence SHALL be bounded and sanitized
The audit SHALL write schema-validated JSON and Markdown under ignored `.codexhost/update-impact/` storage. Persisted evidence MUST NOT include prompts, transcripts, input text, rendered text content, Model values, Thread or Request IDs, credentials, tokens, RPC payloads, complete URLs, function source, full DOM snapshots, screenshots, complete bundles, complete `app.asar`, or user-specific absolute paths.

#### Scenario: Audit records installed Desktop identity
- **WHEN** installation metadata and browser protocol information are available
- **THEN** the report SHALL record bounded version/build, Chromium/protocol identity, and app.asar integrity
- **AND** executable or profile paths SHALL be omitted or reduced to a non-user-specific platform identity

#### Scenario: Inspector returns an unknown field
- **WHEN** a live inspector or baseline document contains data outside the declared audit schema
- **THEN** the audit SHALL reject that input rather than persisting it

### Requirement: Baseline comparison SHALL use an explicit reviewed baseline
The audit SHALL accept an optional explicit reviewed-baseline report and compare normalized contract evidence by contract identifier. It MUST NOT silently select an arbitrary prior report, infer reviewed status from recency, or require a complete historical application.

#### Scenario: Explicit reviewed baseline is supplied
- **WHEN** the baseline schema is valid and identifies a previously reviewed Desktop build
- **THEN** the audit SHALL compare each current contract with the matching baseline contract
- **AND** the report SHALL classify unchanged evidence, material shape changes, and previously unverified surfaces separately

#### Scenario: No baseline is supplied
- **WHEN** the maintainer runs a first audit without a reviewed baseline
- **THEN** the command SHALL still produce current live results
- **AND** it SHALL mark baseline-dependent conclusions as `unverified` rather than choosing another local report

### Requirement: Controlled audit SHALL reuse existing Renderer behavior probes
Controlled mode SHALL use the existing Renderer Control Session and Renderer binding probe for reload, policy installation, Agent switching, prewarm, title, or submission observation. It MUST NOT implement a second production binding or routing flow.

#### Scenario: Maintainer requests controlled installation verification
- **WHEN** controlled mode is enabled for an isolated Desktop lifecycle
- **THEN** the audit SHALL reuse the existing production Renderer source and control-session installation path
- **AND** it SHALL record installation evidence separately from behavior evidence

#### Scenario: Behavior boundary is not requested
- **WHEN** controlled mode installs the binding but does not exercise submission, routing, Fork, or title creation
- **THEN** those behavior boundaries SHALL remain `unverified`
- **AND** the report SHALL NOT claim end-to-end compatibility for them
