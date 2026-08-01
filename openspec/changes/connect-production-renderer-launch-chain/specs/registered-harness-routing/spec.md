## MODIFIED Requirements

### Requirement: Claude Host registration is explicitly development-gated

Production and development Host composition roots SHALL always register Pi and Claude Code through the existing finite HarnessAdapter registry without an enable switch. The default Agent SHALL remain Codex or Pi; Claude Code selection SHALL continue to require its registered transport token.

#### Scenario: Default release Host starts

- **WHEN**the installed release Host starts without a Claude development environment switch
- **THEN**it SHALL register one Pi Adapter and one Claude Code Adapter
- **AND**registration SHALL NOT resolve or start a Claude Code executable

#### Scenario: Installed Claude Code is selected

- **WHEN**a production Renderer submits `codexhost/claude-code-native` and the user-installed Claude Code is available and authenticated
- **THEN**Host SHALL route the Thread through the registered Claude Code Adapter
- **AND**the Adapter SHALL use the user's executable, account, Provider, settings, and Native Session storage

#### Scenario: Claude Code is unavailable

- **WHEN**a production Claude Thread reaches its first Turn without an installed executable or valid authentication
- **THEN**the Claude Code Adapter SHALL return `notInstalled` or `authenticationRequired`
- **AND**Host SHALL NOT forward the request to Codex or Pi
