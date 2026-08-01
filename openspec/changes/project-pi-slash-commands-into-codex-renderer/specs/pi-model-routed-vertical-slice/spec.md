## ADDED Requirements

### Requirement: Pi exposes its RPC-invokable command catalog
PiAdapter SHALL call Pi RPC `get_commands` and normalize Extension Commands as `command`, Prompt Templates as `prompt`, and Skills as `skill`. It SHALL omit native source paths and SHALL NOT publish interactive-only Pi TUI commands that cannot execute through RPC prompt.

#### Scenario: Pi reports all three command sources
- **WHEN** `get_commands` returns one Extension, one Prompt Template, and one Skill
- **THEN** the catalog SHALL contain all three with `command`, `prompt`, and `skill` kinds respectively
- **AND** each public name SHALL omit the leading slash

#### Scenario: Pi reports source provenance
- **WHEN** a command includes a user or project source path and location
- **THEN** PiAdapter MAY use that data to validate native parsing
- **AND** it SHALL remove the provenance before publishing the public descriptor

#### Scenario: Pi TUI-only command exists
- **WHEN** `/settings`, `/model`, `/hotkeys`, or another built-in is absent from RPC-invokable command discovery
- **THEN** PiAdapter SHALL NOT synthesize it from Pi documentation or TUI behavior

### Requirement: PiAdapter exposes explicit compact controls
PiAdapter SHALL add `/compact [instructions]` and `/autocompact [on|off|toggle]` to its command catalog and SHALL implement them through Pi RPC `compact`, `get_state`, and `set_auto_compaction` rather than RPC Prompt text.

#### Scenario: Manual compact is submitted
- **WHEN** a Pi-owned Turn contains `/compact` with optional instructions
- **THEN** PiAdapter SHALL invoke Pi RPC `compact` with the same optional instructions
- **AND** it SHALL NOT send `/compact` through the Pi Prompt command

#### Scenario: Autocompact toggle is submitted
- **WHEN** a Pi-owned Turn contains `/autocompact toggle`
- **THEN** PiAdapter SHALL read the current native auto-compaction state and set the opposite value
- **AND** it SHALL return a displayable confirmed result in the accepted Host Turn

#### Scenario: Autocompact arguments are invalid
- **WHEN** a Pi-owned Turn contains an autocompact argument outside `on`, `off`, or `toggle`
- **THEN** PiAdapter SHALL complete the Turn with explicit usage feedback
- **AND** it SHALL NOT change native auto-compaction state

#### Scenario: Native command collides with an enhanced control
- **WHEN** `get_commands` also reports `compact` or `autocompact`
- **THEN** the public catalog SHALL contain one descriptor for that name
- **AND** the explicit Pi RPC control semantics SHALL remain authoritative

### Requirement: Pi executes discovered and unknown slash input through its Prompt path
Extension, Prompt Template, Skill, and unknown slash input not reserved as an Adapter-enhanced control SHALL be sent unchanged to Pi RPC Prompt in the current Native Session. Neither Host nor PiAdapter SHALL retry the input through Codex when Pi rejects or does not recognize it.

#### Scenario: User selects a Pi Skill
- **WHEN** the user submits `/skill:example arguments` in a Pi Thread
- **THEN** PiAdapter SHALL send that complete input to the current Pi Session Prompt path
- **AND** Pi SHALL own Skill expansion and Agent execution

#### Scenario: User submits an unknown command
- **WHEN** the user submits slash input absent from the current Pi catalog
- **THEN** PiAdapter SHALL send it to Pi for its native result or error
- **AND** official Codex SHALL receive neither the input nor a fallback Turn

### Requirement: Pi commands without Agent Loops settle correctly
PiAdapter SHALL correlate the Pi Prompt response to the active accepted Host Turn. A response with `agentInvoked=false` SHALL complete only after a bounded idle barrier proves no Agent run or streaming continuation started, while preserving prior displayable command output and supported Extension UI Requests.

#### Scenario: Extension only sends a notification
- **WHEN** an Extension Command emits a displayable notification and returns `agentInvoked=false`
- **THEN** PiAdapter SHALL associate that output with the accepted Turn
- **AND** it SHALL complete the Turn successfully exactly once after Pi is idle

#### Scenario: Extension asks a supported question before returning
- **WHEN** an Extension Command sends a supported `select`, `confirm`, `input`, or `editor` request before its Prompt response
- **THEN** the existing Question bridge SHALL keep the request associated with the same Host Turn
- **AND** the Turn SHALL not complete until the Interaction and native command settle

#### Scenario: Agent starts before no-turn completion
- **WHEN** Pi emits Agent start or Turn start before the no-Agent-loop completion barrier
- **THEN** the normal Agent settlement path SHALL own the Turn terminal
- **AND** PiAdapter SHALL NOT emit an early or duplicate terminal

#### Scenario: Prompt result cannot be correlated
- **WHEN** Pi returns a missing, contradictory, or uncorrelated Prompt result and idle completion cannot be proven
- **THEN** PiAdapter SHALL fail the accepted Turn or fault the Session explicitly
- **AND** it SHALL NOT infer success from an empty output buffer
