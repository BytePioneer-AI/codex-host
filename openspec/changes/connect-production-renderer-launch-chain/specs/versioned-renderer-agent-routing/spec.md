## MODIFIED Requirements

### Requirement: Development configuration can enable registered Claude routing

The versioned Renderer Agent control SHALL use an explicit enabled-Agent list. Its production and Probe default list SHALL contain Codex, Pi, and Claude Code without requiring a development configuration. The controlled Probe MUST use the same Composer state machine and request hook as production.

#### Scenario: Default production Renderer installs

- **WHEN**the installed production Renderer starts without a Claude development configuration
- **THEN**the Agent control SHALL contain Codex, Pi, and Claude Code
- **AND**existing Pi transport selection and Codex restoration SHALL remain unchanged

#### Scenario: Claude create is submitted

- **WHEN**a locked Claude Composer creates a Thread on a supported Renderer build
- **THEN**the existing optimistic Model atom SHALL carry `codexhost/claude-code-native`
- **AND**no shared request object or official persistent Model default SHALL be modified

#### Scenario: Disabled or unknown Agent is requested

- **WHEN**code attempts to select an Agent absent from the enabled list
- **THEN**the Renderer SHALL reject the switch and remain on the prior Agent
