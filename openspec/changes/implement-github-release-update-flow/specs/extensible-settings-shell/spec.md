## MODIFIED Requirements

### Requirement: Settings pages are composed through a validated registry
The settings shell SHALL consume an immutable ordered registry of cohesive page definitions. Each definition MUST have a bounded kebab-case ID, a non-empty label, a known icon identity, and a mount function. Registry construction SHALL reject invalid IDs, duplicate IDs, empty registries, and an absent default page.

#### Scenario: Default pages are registered
- **WHEN** the production settings registry is constructed
- **THEN** it SHALL contain Connections, Model Pool, Routes, Gateway, and Updates in deterministic order
- **AND** Connections SHALL be the default page

#### Scenario: Future capability contributes a page
- **WHEN** a later capability composes a valid replacement or additional page definition before shell installation
- **THEN** the shell SHALL render and navigate to that page through the same page contract
- **AND** shell navigation code SHALL NOT require a capability-specific conditional branch

#### Scenario: Page registration is ambiguous
- **WHEN** definitions contain duplicate or invalid IDs or do not contain the configured default page
- **THEN** registry construction SHALL fail before the settings trigger becomes interactive

## ADDED Requirements

### Requirement: Settings exposes a bounded Updates page
The production settings registry SHALL expose one Updates page backed only by a method-specific update client. The page SHALL display current and latest versions, a bounded plain-text excerpt from the GitHub Release body and a GitHub release-notes link when available, one update-and-restart command when installation is available, and bounded checking, preparing, restarting, succeeded, and failed states. It MUST NOT fetch an arbitrary URL, render Release Markdown as HTML, accept native paths or commands, or imply installation succeeded before a terminal status is observed.

#### Scenario: Startup check finds a newer Release
- **WHEN** the fixed background check reports `updateAvailable: true`
- **THEN** the application header SHALL show one compact update shortcut beside the codexhost settings trigger
- **AND** activating the shortcut SHALL open the Updates page directly
- **AND** the shortcut SHALL remain hidden when no update is available or discovery fails

#### Scenario: User opens Updates with a newer installable Release
- **WHEN** the fixed check operation reports a newer version with an installable current-target asset
- **THEN** the page SHALL show both versions, the bounded Release body as plain text, the GitHub release-notes link, and an enabled update-and-restart command

#### Scenario: User starts an update
- **WHEN** the user activates update-and-restart and the fixed start operation accepts it
- **THEN** the page SHALL show bounded preparation or waiting state until the managed Desktop exits
- **AND** installer preparation SHALL show downloaded and total bytes when available
- **AND** duplicate activation SHALL remain disabled

#### Scenario: Application returns after update
- **WHEN** the relaunched Renderer observes the latest operation as succeeded or failed
- **THEN** the Updates page SHALL show the terminal result and a retry action only for failure

#### Scenario: Page closes during a check
- **WHEN** the settings dialog closes or navigates away while check or status work is pending
- **THEN** the page scope SHALL abort and late results SHALL NOT mutate another page
