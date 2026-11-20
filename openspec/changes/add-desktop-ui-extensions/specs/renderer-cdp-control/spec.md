# renderer-cdp-control Spec Delta

## MODIFIED Requirements

### Requirement: Renderer source SHALL cover the current and future documents

For each selected primary target, Desktop Control SHALL register the production source with `Page.addScriptToEvaluateOnNewDocument` before evaluating it in the current document. It SHALL validate the enabled-Agent list (exactly when explicitly configured) and ready Adapter state before returning an installed Session.

#### Scenario: Controller connects after page load

- **WHEN** the primary Renderer document already exists before Desktop Control connects
- **THEN** Desktop Control SHALL register the source for future documents and immediately evaluate it in the current document if it is not already installed with the same hash and a live binding probe
- **AND** it SHALL return success only after the production binding reports ready

#### Scenario: Strict page CSP rejects dynamic code evaluation

- **WHEN** the production Renderer validates a Host Harness inspection response on a page that does not allow `unsafe-eval`
- **THEN** the source SHALL enable the schema library's supported JIT-less mode before any Renderer shared-contract schema initializes
- **AND** a valid Harness inspection SHALL not be reported as a connection error

#### Scenario: Renderer reloads

- **WHEN** the owned target navigates to a new primary document
- **THEN** Chromium SHALL evaluate the registered production source in the new document
- **AND** the Session SHALL re-establish the draft routing policy and validate binding readiness

#### Scenario: Injected Adapter is unsupported

- **WHEN** the production binding reports an unsupported state
- **THEN** Session installation SHALL fail and no installed Session SHALL be retained

### Requirement: Renderer Session SHALL recover target replacement

An installed Renderer Session SHALL rediscover the primary page if its target is absent, closed, or no longer returns a valid binding. It SHALL install and validate the replacement session before retiring the previous client or updating its snapshot.

#### Scenario: Renderer process is replaced

- **WHEN** the owned target disappears and a new primary target becomes available
- **THEN** `ensureInstalled()` SHALL connect to and install the replacement target
- **AND** Desktop Control SHALL remove the old session's extension snapshot registration, if reachable, before closing its client; later execution and activation SHALL use the replacement

#### Scenario: Replacement installation fails

- **WHEN** the new target cannot establish a ready binding or draft routing policy
- **THEN** `ensureInstalled()` SHALL fail without reporting the replacement as installed

## ADDED Requirements

### Requirement: Reconnection SHALL preserve an unchanged installed bundle

Desktop Control SHALL guard core installation in the main document by the SHA-256 of the configured source and the presence of the Renderer binding probe, for both current and future documents.

#### Scenario: Controller reconnects to the same document

- **WHEN** a Controller reconnects and the main document already has the same source hash and an installed binding probe
- **THEN** Desktop Control SHALL register the source for future documents without reinstalling the bundle in the current document
- **AND** when the hash changes or the probe is missing, the production source SHALL run in the current document
