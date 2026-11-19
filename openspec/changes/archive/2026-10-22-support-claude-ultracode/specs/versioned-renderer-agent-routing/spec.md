## MODIFIED Requirements

### Requirement: Claude Model state follows the logical Composer lifecycle
Renderer SHALL scope selected Claude Model Ref, resolved Model display, Catalog, and asynchronous request generation to the same logical Composer identity used for Agent routing. Draft creation SHALL use the request-local carrier, while an existing Claude Thread SHALL change Model only through its validated Host Thread identity and confirmed Session state. When Host rejects a Model or Thinking selection, the picker label returns to the prior confirmed choice, so Renderer SHALL show the rejection reason without requiring hover: a transient notice anchored to the Model control and a failure mark on the trigger until the next successful selection or refresh. Catalog or inspection failures SHALL NOT open that notice.

#### Scenario: Submitted Claude creation retains Model
- **WHEN** a submitted and locked Claude new-Thread Composer transitions from the default target to its created conversation target
- **THEN** the replacement retains the selected Claude Ref and locked Agent state for that exact create

#### Scenario: New task uses the Claude preference
- **WHEN** a Claude conversation transitions to a new default Composer
- **THEN** the new Composer may use the most recently submitted Agent and initializes from the most recent valid Claude Model and Thinking preference
- **AND** it does not inherit uncommitted Model state from the prior Thread Composer

#### Scenario: Existing Claude Thread selects an alias
- **WHEN** a validated current-process Claude Thread selects another Catalog Ref while Idle
- **THEN** Renderer sends the fixed Thread Model-selection request and applies only Host-confirmed `effectiveModel` and `resolvedModelLabel`

#### Scenario: Claude selection fails
- **WHEN** Host rejects Model selection or the Session faults before confirmed state
- **THEN** Renderer keeps the prior confirmed selection when still valid, shows an explicit unavailable state, and does not rewrite the carrier to the requested Ref
- **AND** for a Host rejection of the user's Model or Thinking choice, Renderer shows the Host's reason in a notice above the Model control and marks the trigger, instead of only in the trigger tooltip

#### Scenario: Ultracode cannot run on the chosen Model
- **WHEN** an existing Claude Thread uses Ultracode and the user selects a Model that Claude Code reports cannot run Ultracode
- **THEN** the picker keeps the prior Model and Ultracode, and the notice shows the Host's rejection reason
- **AND** selecting the same rejected Model again shows the notice again, while re-rendering the same rejection does not

#### Scenario: Catalog inspection fails
- **WHEN** the Model control enters an error state because inspection or the Catalog failed rather than because Host rejected a user choice
- **THEN** Renderer keeps the existing explicit unavailable state and does not open the rejection notice

#### Scenario: Claude result becomes stale
- **WHEN** an inspection or selection resolves after Agent, Composer, target, request generation, or extension lifetime changed
- **THEN** Renderer ignores the result and preserves the newer state

#### Scenario: Existing external Thread opens
- **WHEN** Host ownership inspection restores a Pi or Claude Code conversation
- **THEN** Renderer uses only that Thread's Host-confirmed Model and Thinking state
- **AND** opening or revisiting the Thread neither reads nor overwrites the new-Thread Model and Thinking preference
