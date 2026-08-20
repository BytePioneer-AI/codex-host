# extensible-settings-shell Specification

## Purpose
Define the browser-safe, window-scoped codexhost settings shell, validated page extension contract, application-header trigger, lifecycle isolation, responsive presentation, and honest unavailable-state boundary for future runtime settings.
## Requirements
### Requirement: Codex Renderer exposes one codexhost settings shell
The Renderer Extension SHALL install one window-scoped codexhost settings shell and one owned settings trigger as the first control in the verified Codex application-header right-side action group. The trigger SHALL remain present when that group has no native actions in a blank Thread and SHALL appear immediately before the native Open Location control when it is available. The shell and trigger SHALL remain independent of Composer, Thread, Harness, Model, Thinking, and submission state.

#### Scenario: User opens settings from the application header
- **WHEN** the user activates the owned codexhost icon in the Codex application header
- **THEN** the window-scoped settings dialog SHALL open on its default Connections page
- **AND** Agent, Model, Composer phase, and native create state SHALL remain unchanged

#### Scenario: Blank Thread has no native header actions
- **WHEN** the application header does not render Open Location or the context menu for a blank Thread
- **THEN** the settings trigger SHALL remain mounted in the structurally verified right-side action position
- **AND** it SHALL remain immediately before Open Location if native actions later appear

#### Scenario: Codex replaces the application header
- **WHEN** Renderer mutation scanning observes that the mounted header trigger is disconnected
- **THEN** Renderer SHALL mount one replacement trigger immediately before Open Location in the next verified header action group
- **AND** it SHALL NOT create a second dialog, trigger, or configuration state store

#### Scenario: Verified header action group is unavailable
- **WHEN** Renderer cannot identify either a visible bounded native action group or its structurally verified empty action position
- **THEN** it SHALL NOT place the trigger in a guessed native control or fixed overlay
- **AND** a later Renderer scan MAY retry placement

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
The foundation Connections, Model Pool, Routes, and Gateway pages SHALL present bounded operational unavailable states until their owning Runtime capabilities are implemented. Connections SHALL own discovered Credential Sources, explicit authorization, custom Provider endpoints, API Keys, OAuth accounts, and local inference services. Model Pool SHALL project only verified Model Routes produced by authorized Connections. Routes SHALL own explicit and default Route selection, while Gateway SHALL expose bounded operational status and advanced diagnostics. These pages MUST NOT display synthetic Provider, Model, account, credential, route, Gateway, or connection data and MUST NOT expose editable controls that imply persistence or execution.

#### Scenario: User opens a future capability page
- **WHEN** the foundation has no Runtime implementation for that capability
- **THEN** the page SHALL show an explicit unavailable status
- **AND** it SHALL NOT offer a Save, Connect, Start, Test, or credential-entry action

#### Scenario: User opens a foundation page
- **WHEN** none of the later configuration capabilities are installed
- **THEN** the selected page SHALL report that its owning capability is unavailable without inventing configuration values

### Requirement: Connections and Model Pool preserve credential boundaries
A future Connections capability MAY discover supported local Harness/CLI login sources and limited non-sensitive status without reading secrets into Renderer. Discovery MUST NOT authorize a source or add it to Model Pool. Credential Manager SHALL require explicit user authorization before establishing a revocable runtime Credential Lease. Model Pool SHALL contain verified Model Routes derived from authorized Connections and MUST NOT contain raw OAuth Tokens, Refresh Tokens, API Keys, or copied Harness authentication files. Managed Harnesses SHALL receive only a local Gateway endpoint and a Route- and lifecycle-bounded temporary credential.

#### Scenario: A supported local CLI login is discovered
- **WHEN** Connections detects a supported local Harness/CLI credential source
- **THEN** it SHALL expose only bounded source type and availability metadata
- **AND** it SHALL NOT establish a lease or make its models selectable before explicit user authorization

#### Scenario: An authorized connection contributes models
- **WHEN** Credential Manager can establish a valid lease and the Provider Catalog and protocol capabilities are verified
- **THEN** Model Pool SHALL expose the resulting distinguishable Model Routes
- **AND** no source credential SHALL be returned to Renderer or copied to another Harness

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

### Requirement: Settings presentation follows bounded Codex locale state
The Renderer Extension SHALL resolve settings presentation from a validated Codex `localeOverride` and automatic locale inputs through fixed method-specific operations. It SHALL provide owned English and Simplified Chinese messages for the settings trigger, shell controls, navigation, accessibility labels, foundation pages, language options, and errors. It MUST expose the selected owned locale through the settings Shadow host `lang` attribute and MUST NOT infer language from translated DOM text, private React state, or the Codex document `lang` attribute.

#### Scenario: User configured an explicit supported language
- **WHEN** the validated Codex locale override is an English or Chinese language tag
- **THEN** the settings trigger and shell SHALL use the corresponding owned English or Simplified Chinese catalog
- **AND** the settings Shadow host SHALL expose the corresponding owned locale

#### Scenario: Codex language is automatic
- **WHEN** the validated locale override is `null`
- **THEN** Renderer SHALL resolve the preferred locale from bounded Codex automatic locale inputs
- **AND** it SHALL use the matching owned catalog when English or Chinese is resolved

#### Scenario: Locale bridge or response is unavailable
- **WHEN** a fixed locale read times out, fails, or returns a malformed response
- **THEN** settings SHALL remain usable with a browser-language or English fallback
- **AND** Renderer SHALL NOT expose an arbitrary native request fallback or claim an explicit Codex override

#### Scenario: Codex uses an unsupported catalog language
- **WHEN** the validated preferred locale is neither English nor Chinese
- **THEN** settings SHALL render its English fallback catalog
- **AND** it SHALL preserve the unsupported Codex override as an honest non-writable current selection until the user chooses a supported option

### Requirement: Settings exposes a visible bounded language selector
The settings sidebar SHALL display an interface-language selector with Automatic, English, and Simplified Chinese choices. Automatic MUST write Codex `localeOverride` as `null`, English MUST write `en-US`, and Simplified Chinese MUST write `zh-CN` through one fixed method-specific locale operation. The selector MUST NOT expose an arbitrary setting key, locale value, URL, method, or payload.

#### Scenario: User chooses English or Simplified Chinese
- **WHEN** the user selects a supported explicit language and the bounded Codex setting write succeeds
- **THEN** the dialog SHALL remain open using the selected owned catalog
- **AND** the active settings page SHALL remain selected
- **AND** the selector SHALL expose the confirmed explicit language

#### Scenario: User chooses Automatic
- **WHEN** the user selects Automatic and the bounded Codex setting write succeeds
- **THEN** Renderer SHALL clear the explicit locale override with `null`
- **AND** the open dialog SHALL use the newly resolved automatic language without resetting its active page

#### Scenario: Language write is pending
- **WHEN** a bounded locale setting update has not settled
- **THEN** the selector SHALL be disabled until the operation completes or fails
- **AND** duplicate writes SHALL NOT be issued from that control

#### Scenario: Language write fails
- **WHEN** the fixed locale setting operation rejects, times out, or returns a malformed response
- **THEN** the selector SHALL restore its prior confirmed selection
- **AND** the shell SHALL show a localized accessible inline error
- **AND** the existing dialog language and active page SHALL remain usable

#### Scenario: Narrow settings window displays language control
- **WHEN** the settings dialog uses its narrow layout
- **THEN** the language selector SHALL remain visible without overlapping horizontal navigation, page content, or the close control
- **AND** it SHALL NOT introduce page-level horizontal overflow

### Requirement: Settings exposes a bounded Updates page
The production settings registry SHALL expose one Updates page backed only by a method-specific update client. The page SHALL display current and latest versions, a bounded GitHub Release body rendered as structured Markdown and a GitHub release-notes link when available, one update-and-restart command when installation is available, and bounded checking, preparing, restarting, succeeded, and failed states. It MUST NOT fetch an arbitrary URL, accept native paths or commands, or imply installation succeeded before a terminal status is observed.

#### Scenario: Startup check finds a newer Release
- **WHEN** the fixed background check reports `updateAvailable: true`
- **THEN** the application header SHALL show one compact update shortcut beside the codexhost settings trigger
- **AND** activating the shortcut SHALL open the Updates page directly
- **AND** the shortcut SHALL remain hidden when no update is available or discovery fails

#### Scenario: User opens Updates with a newer installable Release
- **WHEN** the fixed check operation reports a newer version with an installable current-target asset
- **THEN** the page SHALL show both versions, the bounded Release body as structured Markdown, the GitHub release-notes link, and an enabled update-and-restart command

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

