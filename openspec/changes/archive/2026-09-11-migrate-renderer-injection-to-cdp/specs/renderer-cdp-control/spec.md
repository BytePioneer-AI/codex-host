## ADDED Requirements

### Requirement: Production control SHALL connect directly to the primary Renderer CDP target
Desktop Control SHALL accept only a loopback HTTP Renderer CDP origin and SHALL select a page target only when its URL is the primary `app://-/index.html` surface. It MUST exclude avatar overlays and unrelated pages and MUST preserve an already owned live target when multiple primary targets exist.

#### Scenario: Primary and overlay targets are present
- **WHEN** CDP discovery returns the primary `app://-/index.html` page and an `app://-/avatar-overlay.html` page
- **THEN** Desktop Control SHALL connect only to the primary page target

#### Scenario: Endpoint is not loopback
- **WHEN** production control is given a non-loopback CDP origin or target WebSocket URL
- **THEN** it SHALL reject the endpoint before injecting any source

#### Scenario: Another primary window appears
- **WHEN** the currently owned primary target remains live and another primary page is discovered
- **THEN** the Session SHALL continue controlling its owned target

### Requirement: Renderer source SHALL cover the current and future documents
For each selected primary target, Desktop Control SHALL register the exact configured production source with `Page.addScriptToEvaluateOnNewDocument` before evaluating it in the current document. The configured source SHALL enable the runtime schema library's supported JIT-less mode before any Renderer shared-contract schema initializes so validation remains compatible with the Desktop page's strict Content Security Policy. It SHALL validate the exact enabled-Agent list and ready Adapter state before returning an installed Session.

#### Scenario: Controller connects after page load
- **WHEN** the primary Renderer document already exists before Desktop Control connects
- **THEN** Desktop Control SHALL register the source for future documents and immediately evaluate it in the current document
- **AND** it SHALL return success only after the production binding reports ready

#### Scenario: Strict page CSP rejects dynamic code evaluation
- **WHEN** the production Renderer validates a Host Harness inspection response on a page that does not allow `unsafe-eval`
- **THEN** schema validation SHALL use its supported JIT-less execution path
- **AND** a valid Harness inspection SHALL not be reported as a connection error

#### Scenario: Renderer reloads
- **WHEN** the owned target navigates to a new primary document
- **THEN** Chromium SHALL evaluate the registered production source in the new document
- **AND** the Session SHALL re-establish the draft routing policy and validate binding readiness

#### Scenario: Injected Adapter is unsupported
- **WHEN** the production binding reports an unsupported state
- **THEN** Session installation SHALL fail and no installed Session SHALL be retained

### Requirement: Draft request routing SHALL install through direct Renderer evaluation
Desktop Control SHALL discover the unique reviewed Request Manager and active non-empty Host ID in the selected Renderer and SHALL install the existing fixed draft prewarm bridge directly in that execution context. It MUST NOT require Electron `webContents`, expose a generic request API, or select an ambiguous manager.

#### Scenario: One owned Request Manager is present
- **WHEN** the active Composer resolves one reviewed Request Manager, request client, prewarmed Thread manager, and Host ID
- **THEN** Desktop Control SHALL install the existing owned request bridge and report it ready

#### Scenario: Request Manager is ambiguous
- **WHEN** discovery cannot select exactly one manager for the active Host
- **THEN** installation SHALL remain unavailable and retry only within the bounded installation timeout

### Requirement: Renderer Session SHALL recover target replacement
An installed Renderer Session SHALL rediscover the primary page whenever its owned target is absent, closed, or no longer returns a valid production binding. It SHALL close the stale CDP client, connect to the replacement target, register and immediately inject the source, reinstall draft routing, and update its snapshot only after validation succeeds.

#### Scenario: Renderer process is replaced
- **WHEN** the owned target disappears and a new primary target becomes available
- **THEN** `ensureInstalled()` SHALL connect to and install the replacement target
- **AND** later Renderer execution and activation SHALL use the replacement

#### Scenario: Replacement installation fails
- **WHEN** the new target cannot establish a ready binding or draft routing policy
- **THEN** `ensureInstalled()` SHALL fail without reporting the replacement as installed

### Requirement: Renderer activation SHALL use the owned page target
Authenticated attachment SHALL activate the controlled Desktop through the selected page target and SHALL claim success only when the CDP activation command completes.

#### Scenario: Healthy controlled instance is attached
- **WHEN** a valid attachment request reaches a Session with an installed primary target
- **THEN** Desktop Control SHALL call `Page.bringToFront` for that target and return attachment success
