## ADDED Requirements

### Requirement: Claude inspection separates installation from Model support
The development-gated Claude Code Adapter SHALL inspect whether its configured user executable can be resolved without starting an SDK Query or creating a Native Session. Lack of Model catalog or Model-selection support MUST NOT by itself report an installed Harness as unavailable.

#### Scenario: Claude executable is resolvable
- **WHEN** Claude inspection resolves the configured executable
- **THEN** the Adapter SHALL return a ready inspection with an empty Model catalog and `configuration.selectModel=false`
- **AND** it SHALL NOT create a Query, child process, or Native Session

#### Scenario: Claude executable is missing
- **WHEN** Claude inspection cannot resolve the configured executable
- **THEN** the Adapter SHALL return a normalized `notInstalled` inspection
- **AND** it SHALL NOT defer that known failure to a created Host Thread

### Requirement: Unsupported Claude open modes are explicit
Until the development-gated Claude Adapter implements Native history mapping, `open(resume)`, `open(fork)`, and `readSnapshot()` SHALL return `unsupported`. Invalid create input SHALL remain `invalidRequest`.

#### Scenario: Caller resumes a Claude Native Session
- **WHEN** a caller invokes `open(resume)` on ClaudeCodeAdapter
- **THEN** the Adapter SHALL return `unsupported`
- **AND** it SHALL NOT start a transport or create a replacement Native Session

#### Scenario: Caller Forks a Claude Native Session
- **WHEN** a caller invokes `open(fork)` on ClaudeCodeAdapter
- **THEN** the Adapter SHALL return `unsupported`
- **AND** it SHALL continue to declare both history Fork capabilities false

### Requirement: Claude package root exposes only production Adapter ownership
The Claude Code Adapter package root SHALL directly export only the concrete Adapter, its production options, and package metadata. It SHALL NOT directly re-export Claude SDK transport interfaces, native message accumulators, executable helpers, or test dependency types.

#### Scenario: Production Host imports Claude Adapter
- **WHEN** Host composition imports the Claude package root
- **THEN** it SHALL consume only ClaudeCodeAdapter and package metadata
- **AND** no Claude SDK message or transport type SHALL enter Host production code

#### Scenario: Adapter tests inject a fake transport
- **WHEN** Claude Adapter tests need deterministic native behavior
- **THEN** they SHALL use package-internal test seams
- **AND** the production package root SHALL not expand for that test
