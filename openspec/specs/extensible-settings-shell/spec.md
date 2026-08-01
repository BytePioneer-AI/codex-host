# extensible-settings-shell Specification

## Purpose
Define the browser-safe, window-scoped codexhost settings shell, validated page extension contract, application-header trigger, lifecycle isolation, responsive presentation, and honest unavailable-state boundary for future runtime settings.
## Requirements
### Requirement: Codex Renderer exposes one codexhost settings shell
The Renderer Extension SHALL install one window-scoped codexhost settings shell and one owned icon-only settings trigger immediately before the verified Codex application-header action group. The shell and trigger SHALL remain independent of Composer, Thread, Harness, Model, Thinking, and submission state.

#### Scenario: User opens settings from the application header
- **WHEN** the user activates the owned codexhost icon in the Codex application header
- **THEN** the window-scoped settings dialog SHALL open on its default Overview page
- **AND** Agent, Model, Composer phase, and native create state SHALL remain unchanged

#### Scenario: Codex replaces the application header
- **WHEN** Renderer mutation scanning observes that the mounted header trigger is disconnected
- **THEN** Renderer SHALL mount one replacement trigger immediately before the next verified header action group
- **AND** it SHALL NOT create a second dialog, trigger, or configuration state store

#### Scenario: Verified header action group is unavailable
- **WHEN** Renderer cannot identify the observed application-header surface or a bounded right-side native action group
- **THEN** it SHALL NOT place the trigger in a guessed native control or fixed overlay
- **AND** a later Renderer scan MAY retry placement

### Requirement: Settings pages are composed through a validated registry
The settings shell SHALL consume an immutable ordered registry of cohesive page definitions. Each definition MUST have a bounded kebab-case ID, a non-empty label, a known icon identity, and a mount function. Registry construction SHALL reject invalid IDs, duplicate IDs, empty registries, and an absent default page.

#### Scenario: Default pages are registered
- **WHEN** the production settings registry is constructed
- **THEN** it SHALL contain Overview, Routes, Providers, Credentials, Local Models, and Gateway in deterministic order
- **AND** Overview SHALL be the default page

#### Scenario: Future capability contributes a page
- **WHEN** a later capability composes a valid replacement or additional page definition before shell installation
- **THEN** the shell SHALL render and navigate to that page through the same page contract
- **AND** shell navigation code SHALL NOT require a capability-specific conditional branch

#### Scenario: Page registration is ambiguous
- **WHEN** definitions contain duplicate or invalid IDs or do not contain the configured default page
- **THEN** registry construction SHALL fail before the settings trigger becomes interactive

### Requirement: Settings shell owns responsive and isolated presentation
The settings shell SHALL render inside an owned Shadow Root with owned CSS and bundled browser-safe icons. It SHALL provide a constrained desktop dialog, a narrow-window layout, stable navigation dimensions, scrollable page content, owned light/dark palettes, and forced-colors system fallbacks without relying on Codex private React components, color variables, utility classes, or DOM styling. Its desktop visual structure SHALL align with the reviewed Codex settings baseline through a 240px navigation rail, centered bounded content column, neutral navigation states, and grouped settings rows while retaining owned implementation and palettes.

#### Scenario: Desktop-sized window opens settings
- **WHEN** the dialog opens in a desktop-sized Renderer viewport
- **THEN** navigation and content SHALL render as a stable two-column settings layout
- **AND** dynamic page content SHALL scroll without resizing or shifting the dialog controls

#### Scenario: Narrow window opens settings
- **WHEN** available width cannot contain the two-column layout
- **THEN** navigation SHALL become a horizontally scrollable compact row and content SHALL remain readable without overlapping the close control

#### Scenario: Codex visual implementation changes
- **WHEN** a later Codex release renames or removes the private settings classes, tokens, routes, or components observed during design review
- **THEN** the codexhost settings shell SHALL continue to render from its owned DOM and CSS
- **AND** no production selector or import SHALL depend on those private implementation details

#### Scenario: Codex private theme CSS changes
- **WHEN** Codex private color variables are absent, renamed, or semantically incompatible
- **THEN** the shell SHALL remain legible using its owned palette or forced-colors system fallback

### Requirement: Settings navigation and dialog lifecycle are accessible
The settings trigger and dialog SHALL expose appropriate accessible names and state. Opening SHALL move focus into the dialog; Escape, the close icon, and an owned backdrop action SHALL close it; closing SHALL restore focus to the connected opener when possible. Navigation SHALL expose the active page and support keyboard activation without trapping focus after close.

#### Scenario: Keyboard user opens and closes settings
- **WHEN** the focused settings trigger is activated and the user later presses Escape
- **THEN** the dialog SHALL close and focus SHALL return to that trigger when it remains connected

#### Scenario: User changes page
- **WHEN** the user activates another settings navigation item
- **THEN** that item SHALL be exposed as current
- **AND** the page heading and content SHALL be replaced without opening another modal

#### Scenario: Original trigger was removed
- **WHEN** Codex replaces the application header before the dialog closes
- **THEN** close SHALL complete without focusing a disconnected element or throwing

### Requirement: Page asynchronous work is current and cancellable
Each mounted page SHALL receive a page-scoped AbortSignal and a latest-result helper. Navigation, dialog close, page replacement, and shell disposal MUST abort the active page scope. Success and failure handlers MUST run only for the current request generation of the current mounted page.

#### Scenario: User navigates before a request resolves
- **WHEN** an asynchronous operation from the previous page settles after another page becomes active
- **THEN** its result SHALL NOT modify the new page
- **AND** the previous page's AbortSignal SHALL be aborted

#### Scenario: Page starts a newer request
- **WHEN** a second latest-result operation starts before the first settles in the same page scope
- **THEN** only the second operation's current result SHALL be applied

#### Scenario: Settings closes during a request
- **WHEN** the dialog closes while its active page operation is pending
- **THEN** the operation's page scope SHALL be aborted
- **AND** a late success or failure SHALL be ignored

### Requirement: Foundation pages report only implemented capability
The foundation Overview, Routes, Providers, Credentials, Local Models, and Gateway pages SHALL present bounded operational unavailable states until their owning Runtime capabilities are implemented. They MUST NOT display synthetic Provider, Model, account, credential, route, Gateway, or local-model data and MUST NOT expose editable controls that imply persistence or execution.

#### Scenario: User opens a future capability page
- **WHEN** the foundation has no Runtime implementation for that capability
- **THEN** the page SHALL show an explicit unavailable status
- **AND** it SHALL NOT offer a Save, Connect, Start, Test, or credential-entry action

#### Scenario: User opens Overview
- **WHEN** none of the later configuration capabilities are installed
- **THEN** Overview SHALL summarize each section as unavailable without inventing configuration values

### Requirement: Settings extension boundary remains browser-only and method-specific
The settings shell and page framework MUST NOT import Node.js built-ins, Electron private APIs, Harness SDKs, or another internal Runtime package. The shell MUST NOT expose a generic method/payload requester, arbitrary URL fetcher, global request client, filesystem access, process control, or credential reader. Future pages SHALL close over capability-owned method-specific clients and Runtime Schemas.

#### Scenario: Future Routes page performs asynchronous work
- **WHEN** a Routes capability is later composed into the registry
- **THEN** it SHALL call explicit Route client methods from within its page-owned operation closure
- **AND** the shell SHALL provide only cancellation and current-result lifecycle

#### Scenario: Generic request capability is introduced
- **WHEN** settings code exports an arbitrary method/payload API, arbitrary URL fetch, or native method passthrough
- **THEN** boundary checks or focused tests SHALL fail

#### Scenario: Foundation is built for browser
- **WHEN** the production Renderer IIFE is bundled
- **THEN** settings pages, owned CSS, and selected icons SHALL be included without a Node.js, Electron, Harness, Model Gateway, or Credential Manager Runtime dependency

### Requirement: Settings lifecycle preserves existing Renderer behavior
Installing, opening, navigating, closing, or disposing settings SHALL NOT modify Agent selection, Model selection, Thread ownership, prewarm policy, title policy, slash-command ownership, sidebar decoration, native Fork behavior, or Composer submission routing. Renderer disposal SHALL remove the owned application-header settings trigger and shell DOM and abort pending page work.

#### Scenario: Settings is opened during a draft
- **WHEN** a draft Composer has a selected Agent and Model before settings opens and closes
- **THEN** the same Agent, Model, phase, and submission behavior SHALL remain active afterward

#### Scenario: Renderer binding is disposed
- **WHEN** Desktop Control or a reinstall disposes the active Renderer binding
- **THEN** the application-header settings trigger and the window shell SHALL be removed
- **AND** pending settings operations SHALL be aborted and late results ignored

#### Scenario: Renderer is reinstalled after reload
- **WHEN** Desktop Control reinstalls the production Renderer after page reload
- **THEN** exactly one new window settings shell SHALL be installed with the production registry
- **AND** existing Agent and Model controls SHALL continue through their established installation path
