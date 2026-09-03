## ADDED Requirements

### Requirement: DSH Modern import contracts are fixed and browser-safe

Shared Contracts SHALL export strict browser-safe Runtime Schemas for exactly two DSH Modern import operations: an empty candidate-list request and a Native Session import request. Candidate results SHALL contain only bounded Native Session ID, cwd, title or null, update time and running state; import params SHALL contain only Native Session ID; import results SHALL contain only Host Thread ID. The contracts MUST NOT expose a generic Harness method, arbitrary payload, DSH SDK/wire type, Native event, Transcript, Prompt, Tool output, credential, URL, token, cookie or undeclared field.

#### Scenario: Renderer validates a candidate list

- **WHEN** Host returns bounded candidates with valid identity, cwd, title, update time and running state
- **THEN** Shared Contracts SHALL accept the result from a browser bundle
- **AND** absent DSH projection values and filtered blank/origin metadata SHALL not need to cross into Renderer

#### Scenario: Renderer adds untrusted import metadata

- **WHEN** import params include cwd, title, updatedAt, running, Model, Thinking, Permission, preview or another undeclared field
- **THEN** the strict Schema SHALL reject the request
- **AND** Host SHALL not begin candidate revalidation or provisional persistence

#### Scenario: Host returns an invalid candidate or result

- **WHEN** a Session ID/title/cwd exceeds its bound, update time is invalid, candidate count exceeds its limit, an undeclared key is present, or result Thread ID is invalid
- **THEN** the corresponding Schema SHALL fail closed
- **AND** Renderer SHALL not display or navigate from that value

#### Scenario: Shared Contracts is bundled for browser

- **WHEN** the representative import Schemas are bundled from the package public entry
- **THEN** the build SHALL contain no Node.js builtin, Electron private API, DSH package or other codexhost Runtime dependency
