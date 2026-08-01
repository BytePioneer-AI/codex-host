## ADDED Requirements

### Requirement: Shared Thread ownership-list contracts are strict and bounded
Shared Contracts SHALL export browser-safe strict Runtime Schemas for a fixed Thread ownership-list request and response. Request params SHALL contain one to 100 unique Host Thread IDs. Each result entry SHALL identify the requested Host Thread as either Codex-owned or external with a bounded non-empty Harness ID, and SHALL expose no Native Ref, path, Transcript, Model, Provider, credential, or arbitrary payload.

#### Scenario: Renderer validates a bounded ownership batch
- **WHEN** Renderer submits unique valid Host Thread IDs and receives one strict ownership entry for each ID
- **THEN** the public Runtime Schemas SHALL accept the params and result without importing Node.js, Electron, a Harness SDK, or another codexhost package

#### Scenario: Ownership request is unbounded or ambiguous
- **WHEN** params are empty, contain more than 100 IDs, contain duplicate IDs, or include an undeclared field
- **THEN** the params Runtime Schema SHALL reject the request

#### Scenario: Ownership result leaks runtime data
- **WHEN** a result entry includes a Native Ref, transport Model, cwd, title, history, Provider, or undeclared field
- **THEN** the result Runtime Schema SHALL reject the response
