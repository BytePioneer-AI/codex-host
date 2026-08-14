## ADDED Requirements

### Requirement: Production Host SHALL register and route Grok

Protocol Core SHALL include `grok` in the finite external Harness registry and SHALL decode `codexhost/grok-native` plus its bounded selected configuration only as Grok-owned traffic. The production composition root SHALL construct GrokAdapter and inject it through the same `HarnessAdapter` registry used by Pi and Claude Code.

#### Scenario: Grok Thread is created
- **WHEN** `thread/start.model` contains a valid Grok transport carrier
- **THEN** Host SHALL open GrokAdapter with only that request's decoded Model and Thinking selection
- **AND** subsequent operations SHALL remain bound to the resulting Grok HarnessSession

#### Scenario: Grok carrier is malformed or unavailable
- **WHEN** a Grok-prefixed carrier is malformed or GrokAdapter cannot open it
- **THEN** Host SHALL reject the external request explicitly
- **AND** it SHALL NOT route the request to official Codex, Pi, or Claude Code

### Requirement: Generic external routing SHALL consume Grok capabilities without ACP branches

Host Runtime SHALL route Grok Turn, interrupt, read, inspection, configuration, Usage, ownership, delete, and close operations through existing generic external Thread behavior. Host Runtime MUST NOT import ACP SDK types, parse Grok events, or read Grok Session files.

#### Scenario: Grok and existing Harnesses coexist
- **WHEN** Grok, Pi, and Claude Code Threads are loaded in one Host
- **THEN** each operation SHALL invoke only its owning HarnessSession
- **AND** Grok output SHALL use the same Host projectors and response-ordering gates as other external Harnesses
