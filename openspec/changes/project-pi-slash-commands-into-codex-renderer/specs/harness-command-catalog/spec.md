## ADDED Requirements

### Requirement: Harness command catalogs are normalized and executable
A Harness command catalog SHALL contain only commands that the inspected Harness context or owning HarnessSession can accept, plus explicitly documented Adapter-enhanced Session controls backed by official native operations. Each descriptor SHALL have a unique name without the leading slash, a description, an argument hint, and a reliable `command`, `prompt`, `skill`, or `unknown` kind; entries SHALL be bounded, de-duplicated, and deterministically ordered.

#### Scenario: Native source is classified reliably
- **WHEN** a Harness native interface identifies an entry as a Prompt Template or Skill
- **THEN** the Adapter SHALL publish the matching `prompt` or `skill` kind
- **AND** it SHALL NOT flatten that entry based only on its description

#### Scenario: Native source cannot be classified
- **WHEN** the Harness reports an executable command without reliable source metadata
- **THEN** the Adapter SHALL publish `kind=unknown`
- **AND** it SHALL NOT infer a kind from the command name or prose

#### Scenario: Native metadata contains private provenance
- **WHEN** a native catalog entry includes a source path, package location, executable path, credential, Provider configuration, or arbitrary payload
- **THEN** the public descriptor SHALL omit that metadata

#### Scenario: Adapter enhances the Session catalog
- **WHEN** an Adapter publishes a command not returned by native command discovery
- **THEN** that command SHALL be backed by an explicit official native Session operation with equivalent observable semantics
- **AND** the Adapter design and tests SHALL identify it as enhanced rather than native

### Requirement: Draft and live command discovery use the owning Harness context
Draft command discovery SHALL use `HarnessAdapter.inspect()` with the exact normalized cwd and effective supported configuration without creating a durable Native Session. Live command discovery SHALL use `HarnessSession.getCommandCatalog()` for the owning Session and SHALL NOT query another Harness.

#### Scenario: New external Harness draft requests commands
- **WHEN** a draft with a verified cwd requests command discovery
- **THEN** Host SHALL inspect the selected registered Harness with command catalog inclusion
- **AND** any temporary native process SHALL close before inspection resolves

#### Scenario: Open external Thread requests commands
- **WHEN** an existing external Thread requests its current catalog
- **THEN** Host SHALL query the Session owned by that Thread's immutable Harness
- **AND** the result SHALL reflect the Session context rather than a process-global catalog

#### Scenario: Draft cwd is unavailable
- **WHEN** the UI cannot identify one exact cwd for a draft
- **THEN** it SHALL NOT query command discovery using Host process cwd or another project's cwd

### Requirement: Command selection and manual input share one Turn route
Selecting a Harness command SHALL produce canonical slash text in the Composer and SHALL use the same normal Turn submission route as manually typed slash input. HarnessAdapter SHALL NOT expose a generic `executeSlashCommand` or native method escape hatch; the owning Adapter MAY internally translate explicitly enhanced command text to an official native operation while preserving the Host Turn lifecycle.

#### Scenario: User selects a Skill
- **WHEN** the user selects a catalog Skill with arguments and submits it
- **THEN** the owning Harness SHALL receive the canonical `/skill-name arguments` input through the normal Turn route

#### Scenario: User manually types the same command
- **WHEN** the user manually submits the same canonical slash input
- **THEN** it SHALL reach the same owning Adapter behavior as menu selection

#### Scenario: Harness does not recognize slash input
- **WHEN** a user submits slash input absent from the current catalog
- **THEN** the input SHALL still be delivered to the current Harness for its native result or error
- **AND** it SHALL NOT be retried through Codex or another Harness

### Requirement: Accepted commands preserve complete Host Turn lifecycles
Every accepted slash input SHALL satisfy the existing Host Turn and Interaction ordering whether the native Harness starts an Agent Loop, handles the command locally, or invokes an Adapter-enhanced Session control.

#### Scenario: Command runs an Agent Loop
- **WHEN** the native command starts Agent processing
- **THEN** the Adapter SHALL use the normal Agent settlement path and emit exactly one Host Turn terminal

#### Scenario: Command completes without an Agent Loop
- **WHEN** the native command reports successful local handling without starting Agent processing
- **THEN** the Adapter SHALL preserve any associated displayable output or supported Interaction
- **AND** it SHALL complete the accepted Host Turn exactly once after a proven idle barrier

#### Scenario: Command requires unsupported native UI
- **WHEN** a command cannot complete because its required native UI cannot be represented or degraded honestly
- **THEN** the accepted Turn SHALL end with an explicit unsupported or failed result
- **AND** the Adapter SHALL NOT report success from the absence of Agent output

### Requirement: Command catalog caching is contextual and refreshable
Command catalog caching MAY be process-local and short-lived, but SHALL distinguish draft configuration and live Session identity, SHALL support explicit refresh, and SHALL never become a persisted command truth source.

#### Scenario: Two projects expose different commands
- **WHEN** two drafts use different cwd values
- **THEN** a cached result for one cwd SHALL NOT populate the other draft

#### Scenario: Session configuration changes
- **WHEN** a Model, Thinking option, Session identity, or other normalized discovery input changes
- **THEN** stale matching catalog state SHALL be invalidated or bypassed

#### Scenario: Host restarts
- **WHEN** a new Host process starts
- **THEN** it SHALL rediscover commands rather than load a persisted codexhost catalog
