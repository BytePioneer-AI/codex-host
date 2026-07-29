## ADDED Requirements

### Requirement: Development configuration can enable registered Claude routing
The versioned Renderer Agent control SHALL use an explicit enabled-Agent list. Its default list SHALL remain Codex and Pi, and a controlled development configuration MAY add Claude Code without introducing another request hook or bypassing the existing Composer state machine.

#### Scenario: Default Renderer Probe installs
- **WHEN** no Claude development configuration is present
- **THEN** the Agent control SHALL contain only Codex and Pi
- **AND** existing Pi transport selection and Codex restoration SHALL remain unchanged

#### Scenario: Controlled Probe enables Claude
- **WHEN** the controlled Gate sets the validated Claude development flag before installing the Probe
- **THEN** the same Agent control SHALL add a `Claude Code` option
- **AND** selecting it SHALL use the same draft switch, prewarm clear, submit freeze, replacement transfer, and revisit restoration logic

#### Scenario: Claude create is submitted
- **WHEN** a locked Claude Composer creates a Thread on a supported Renderer build
- **THEN** the existing optimistic Model atom SHALL carry `codexhost/claude-code-native`
- **AND** no shared request object or official persistent Model default SHALL be modified

#### Scenario: Disabled Agent is requested
- **WHEN** code attempts to select an Agent absent from the enabled list
- **THEN** the Renderer SHALL reject the switch and remain on the prior Agent

### Requirement: External Agent title isolation is shared
The main-process title policy SHALL call the official title service only for a uniquely locked Codex Composer. Pi, Claude Code, unknown external Agents, and ambiguous ownership SHALL return the existing local fallback without reading or forwarding Prompt content.

#### Scenario: Claude first Turn requests a title
- **WHEN** the owning Renderer reports one locked Claude Code Composer
- **THEN** title generation SHALL skip the official Codex Harness and use local fallback

#### Scenario: Codex first Turn requests a title
- **WHEN** the owning Renderer reports one locked Codex Composer
- **THEN** original official title generation SHALL remain unchanged

### Requirement: Controlled Renderer evidence recognizes Claude without exposing content
Renderer binding tooling SHALL require an explicit CLI option to enable Claude and SHALL accept only known Agent enum values in sanitized observations.

#### Scenario: Claude Gate observes submission
- **WHEN** a user selects Claude Code and submits in the controlled Renderer
- **THEN** the report SHALL record only Agent enum, anonymous Composer identity, phase, trigger, and transport decoration counts
- **AND** it SHALL omit Prompt, Model value, full DOM, request ID, Thread ID, and Transcript
