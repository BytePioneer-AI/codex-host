## ADDED Requirements

### Requirement: Shared update controls are browser-safe and method-specific
Shared Contracts SHALL export strict Runtime Schemas for empty update check, start, and status params and their bounded results. Results MAY contain SemVer versions, update availability and installation availability, a bounded plain-text GitHub Release body, a trusted GitHub Release HTTPS URL, normalized update installation and phase, bounded installer download byte counts, timestamps, and bounded user-facing errors. They MUST NOT contain or accept artifact URLs, digests, local paths, process IDs, commands, package-manager locations, Controller credentials, arbitrary methods, or undeclared fields.

#### Scenario: Renderer checks the latest stable update
- **WHEN** Renderer sends the fixed check operation with an empty strict parameter object
- **THEN** the result Schema SHALL accept only bounded current/latest version, availability, plain-text release notes, release-notes URL, status, and error fields

#### Scenario: Renderer starts the current candidate
- **WHEN** Renderer sends the fixed start operation with an empty strict parameter object
- **THEN** Host SHALL choose the candidate and the result SHALL expose only its normalized operation status

#### Scenario: Renderer reads status
- **WHEN** Renderer sends the fixed status operation with an empty strict parameter object
- **THEN** the result SHALL contain either no operation or one strict bounded update status

#### Scenario: Renderer reads installer download progress
- **WHEN** an installer artifact is downloading
- **THEN** the status result MAY contain nonnegative `downloadedBytes` and positive `totalBytes`
- **AND** `downloadedBytes` SHALL NOT exceed `totalBytes`

#### Scenario: Renderer attempts to choose an artifact
- **WHEN** check, start, or status params include a URL, version, digest, target, path, command, or another undeclared property
- **THEN** the corresponding strict Schema SHALL reject the request
