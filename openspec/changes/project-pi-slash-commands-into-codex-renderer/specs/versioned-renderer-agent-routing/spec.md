## ADDED Requirements

### Requirement: Pi Composers use only the Pi command catalog
For a supported Desktop build, Renderer Extension SHALL replace Codex slash-command matching, keyboard selection, and mouse selection for a logical Composer whose selected Agent is Pi. It SHALL show the normalized Pi Extension, Prompt, Skill, compact, and autocompact descriptors and SHALL NOT add codexhost application commands or Pi TUI-only commands.

#### Scenario: Pi draft opens slash autocomplete
- **WHEN** the user enters a leading slash in a Pi draft with a verified cwd
- **THEN** Renderer SHALL display only the current Pi catalog returned for that draft context
- **AND** Codex Harness commands SHALL not participate in matching or selection

#### Scenario: Existing Pi Thread opens slash autocomplete
- **WHEN** the user enters a leading slash in a known Pi conversation
- **THEN** Renderer SHALL query the fixed live command method for that exact Host Thread
- **AND** it SHALL display the owning Pi Session catalog

#### Scenario: Codex Composer opens slash autocomplete
- **WHEN** the logical Composer selects Codex
- **THEN** Renderer SHALL preserve the original Codex command registry, matching, and selection behavior
- **AND** it SHALL not query or inject a Pi catalog

#### Scenario: User needs a Desktop operation
- **WHEN** the Pi command menu is active
- **THEN** new Thread, project, status, and other Desktop operations SHALL remain available through their existing non-command UI
- **AND** Renderer SHALL not synthesize `/new`, `/clear`, `/exit`, or another codexhost slash command

### Requirement: Same-name Codex commands cannot consume Pi input
Visual hiding alone SHALL NOT satisfy Pi command projection. For a Pi Composer, the versioned integration SHALL prevent hidden Codex descriptors and handlers from consuming Enter, mouse selection, or exact manually typed same-name input before normal Pi Turn submission.

#### Scenario: Pi and Codex both define compact
- **WHEN** a Pi Composer selects or manually submits `/compact`
- **THEN** no Codex command `onSelect` or official Codex compact request SHALL run
- **AND** the canonical text SHALL reach the Pi-owned Turn route

#### Scenario: Hidden Codex row retains keyboard state
- **WHEN** the underlying Desktop would otherwise keep a hidden Codex command selected
- **THEN** the Pi command controller SHALL suppress that keyboard action
- **AND** Enter SHALL select or submit only according to the Pi command state

#### Scenario: Behavioral isolation cannot be proven
- **WHEN** the current build cannot uniquely isolate Pi slash matching from Codex handlers
- **THEN** Pi slash projection SHALL be marked unavailable and slash submission SHALL fail explicitly rather than execute Codex
- **AND** CSS-only hiding or command registration order SHALL not be used as fallback evidence

### Requirement: Command selection edits Composer text and uses normal submission
Selecting a Pi descriptor SHALL replace the active slash token with canonical `/name ` text and preserve arguments entered afterward. Renderer SHALL NOT call Pi RPC, an Adapter command endpoint, or a generic Host request to execute the selection.

#### Scenario: User selects a Prompt Template
- **WHEN** the user selects a Pi Prompt Template from autocomplete
- **THEN** Renderer SHALL insert its canonical slash name into the Composer
- **AND** later submission SHALL use the existing Agent freeze and `turn/start` path

#### Scenario: User manually types an unknown slash command
- **WHEN** no Pi descriptor matches but the user submits slash text
- **THEN** Renderer SHALL allow the canonical text to follow the Pi-owned normal Turn route
- **AND** it SHALL not reinterpret the input as a Codex command

### Requirement: Command queries are Composer-scoped and stale-safe
Renderer SHALL derive draft command discovery from one structurally verified exact cwd and live discovery from one validated current-process Host Thread ID. Query state SHALL belong to the logical Composer and request generation; navigation, Agent changes, target changes, replacement, refresh, and disposal SHALL invalidate older results.

#### Scenario: Draft cwd is ambiguous
- **WHEN** Renderer cannot prove one exact project cwd for the active Pi draft
- **THEN** command autocomplete SHALL show an explicit unavailable state or remain unavailable
- **AND** Renderer SHALL not send Host process cwd, a DOM label, or a previously visited project's cwd

#### Scenario: Catalog resolves after Agent changes
- **WHEN** a Pi catalog response arrives after the same draft switches to Codex
- **THEN** Renderer SHALL ignore the stale result
- **AND** the Codex command behavior SHALL remain active

#### Scenario: Conversation target changes before response
- **WHEN** a live catalog response arrives after navigation to another Thread
- **THEN** Renderer SHALL not apply the earlier Thread's commands to the new Composer

#### Scenario: Draft becomes the created conversation
- **WHEN** an equivalent Pi draft-to-conversation Composer replacement occurs during submission
- **THEN** command state SHALL transfer only under the existing logical Composer replacement rules
- **AND** a later live refresh SHALL query the created Thread's owning Session

### Requirement: Slash projection is versioned and behaviorally gated
The Renderer command mechanism SHALL be enabled only for a whitelisted Desktop build after structural and behavioral Gates prove the active page instance, Composer association, command isolation, insertion, submission, restoration, and cleanup. Dynamic import of another asset instance, permanent global mutation, ASAR modification, and DOM text scraping SHALL not qualify.

#### Scenario: Current build passes native registry adaptation
- **WHEN** the active slash registry or store is uniquely recovered from the mounted Composer and same-name route evidence passes
- **THEN** the versioned Adapter MAY filter and register commands through that active state instance

#### Scenario: Native registry adaptation is unavailable
- **WHEN** a versioned Pi-only autocomplete controller can instead intercept all relevant slash keyboard and mouse behavior before Codex
- **THEN** that controller MAY be used only after equivalent same-name and cleanup Gates pass

#### Scenario: Desktop asset changes
- **WHEN** the running asset or structural signature differs from the reviewed whitelist
- **THEN** Pi command projection SHALL fail closed
- **AND** the build SHALL require a new real behavioral Gate before support is declared

#### Scenario: Renderer evidence is recorded
- **WHEN** a controlled Gate verifies command projection
- **THEN** evidence MAY include command counts, kinds, collision outcomes, anonymous Composer identity, Agent, and route classification
- **AND** it SHALL omit command descriptions from user files, arguments, Prompt content, Transcript, source paths, credentials, raw Models, and complete request or Thread IDs
