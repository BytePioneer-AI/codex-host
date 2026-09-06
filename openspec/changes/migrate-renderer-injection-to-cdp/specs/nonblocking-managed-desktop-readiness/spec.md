## MODIFIED Requirements

### Requirement: Controller SHALL recover Renderer integration in the background
The Controller SHALL serialize complete direct Renderer CDP Session installation and use. While no valid Session exists, it SHALL retry installation with bounded exponential backoff from 30 seconds to 5 minutes. After a Session becomes ready it SHALL reset that backoff and validate the existing target and binding; a later target, connection, draft-policy, or readiness failure SHALL close and clear that Session and return to complete target discovery and installation retry without terminating the managed Desktop. A failed installation MUST NOT leave or publish an installed Session object.

#### Scenario: User logs in after managed startup
- **WHEN** initial installation fails because the logged-out Renderer has no supported Composer Model or Request Manager state and the user later reaches a supported Composer
- **THEN** a subsequent Controller retry SHALL discover the primary target and install the complete Renderer Session
- **AND** external controls SHALL become available only after existing local prerequisites report ready

#### Scenario: Ready Session loses its Renderer binding
- **WHEN** `ensureInstalled()` fails after a Session previously became ready
- **THEN** the Controller SHALL close and clear the failed Session and continue running
- **AND** it SHALL retry complete target discovery and installation without producing a blocking compatibility result

#### Scenario: Initial direct CDP installation fails
- **WHEN** target discovery, WebSocket connection, source registration, immediate injection, draft routing, or binding validation fails
- **THEN** the Controller SHALL retain no installed Session
- **AND** attachment SHALL not claim activation success until a later complete installation succeeds
