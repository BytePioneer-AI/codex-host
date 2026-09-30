## MODIFIED Requirements

### Requirement: Settings shell owns responsive and isolated presentation
The settings shell SHALL render inside an owned Shadow Root with owned CSS and bundled browser-safe icons. It SHALL present settings as a non-modal page that covers the content area beside the verified Codex navigation rail, below any native titlebar overlay, with a narrow layout driven by the page's own width, stable navigation dimensions, scrollable page content, owned light/dark palettes, and forced-colors system fallbacks. Placement SHALL read only the navigation rail's geometry and SHALL NOT insert into, move, or restyle Codex's content tree. Page content SHALL NOT rely on Codex private React components, color variables, utility classes, or DOM styling.

#### Scenario: Settings opens as a page
- **WHEN** settings opens while a visible navigation rail exists
- **THEN** the page SHALL cover the area from the rail's right edge to the window's right and bottom edges, starting no higher than the titlebar overlay
- **AND** it SHALL NOT show a backdrop or block interaction with the navigation rail
- **AND** it SHALL follow rail and window size changes

#### Scenario: Navigation rail is unavailable
- **WHEN** settings opens without a visible navigation rail
- **THEN** the page SHALL cover the window below the titlebar overlay

#### Scenario: Narrow page
- **WHEN** the page width cannot contain the two-column layout
- **THEN** navigation SHALL become a horizontally scrollable compact row and content SHALL remain readable without overlapping the close control

#### Scenario: Native selection while settings is shown
- **WHEN** the settings page is open
- **THEN** the native rail destination highlight SHALL be hidden with scoped CSS without editing native `data-selected` or `aria-current`
- **AND** the codexhost rail trigger SHALL show the selected treatment and expose `aria-current="page"`
- **AND** closing SHALL remove the scoped CSS and the trigger selection
- **AND** if Codex changes how it draws the rail highlight, settings SHALL remain functional with the native highlight visible

#### Scenario: Codex private theme CSS changes
- **WHEN** Codex private color variables are absent, renamed, or semantically incompatible
- **THEN** the shell SHALL remain legible using its owned palette or forced-colors system fallback

### Requirement: Settings navigation and dialog lifecycle are accessible
The settings trigger and page SHALL expose appropriate accessible names and state. Opening SHALL move focus into the page navigation. Escape and the close icon SHALL close the page and restore focus to the connected opener when possible; a modal owned by a settings page SHALL handle Escape before the page. Native navigation SHALL replace the page without moving focus back to the opener. Activating the trigger while the page is open SHALL keep the current settings page.

#### Scenario: Keyboard user opens and closes settings
- **WHEN** the focused settings trigger is activated and the user later presses Escape
- **THEN** the page SHALL close and focus SHALL return to that trigger when it remains connected

#### Scenario: Native navigation replaces settings
- **WHEN** the user activates a native rail destination, the native current destination changes, or history or URL navigation occurs while settings is open
- **THEN** the settings page SHALL close without restoring focus to the trigger
- **AND** the native click SHALL still reach Codex

#### Scenario: Page-owned modal is open
- **WHEN** a settings page shows its own modal and the user presses Escape
- **THEN** only that modal SHALL close and the settings page SHALL remain open

#### Scenario: User changes page
- **WHEN** the user activates another settings navigation item
- **THEN** that item SHALL be exposed as current
- **AND** the page heading and content SHALL be replaced without opening another modal

#### Scenario: Original trigger was removed
- **WHEN** Codex replaces the navigation rail before settings closes
- **THEN** close SHALL complete without focusing a disconnected element or throwing
