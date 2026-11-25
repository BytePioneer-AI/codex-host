## MODIFIED Requirements

### Requirement: Claude Code publishes stable current context Usage

The Claude Code Adapter MUST update current context Usage passively from validated complete Root Assistant request Usage whenever a still-applicable context window is known. It MUST NOT automatically invoke the stable structured context operation at Assistant, Tool, or ordinary Turn terminal boundaries. An exact context read MUST occur only for an explicit Usage detail refresh or another explicit calibration operation, MUST use the active official SDK Query's stable `getContextUsage()` operation, and MUST map a reliable used/max Token pair into normalized `HostUsage`. The Adapter MUST NOT depend on the SDK experimental Session Usage operation, read local credentials, or call an Anthropic OAuth usage HTTP endpoint.

#### Scenario: Claude Assistant message updates context during an active Turn

- **WHEN** an accepted Claude Turn receives a validated complete Root Assistant message with reliable request input/cache Token usage and the Session already knows a still-applicable context window
- **THEN** the Adapter MUST publish a `session.usage.changed` snapshot associated with the active Turn using that request observation as the current context estimate
- **AND** the Adapter MUST NOT call `getContextUsage()` for that Assistant boundary

#### Scenario: Local Tool completes during an active Turn

- **WHEN** a Claude Tool execution completes without a new Root Assistant response
- **THEN** the Adapter MUST NOT publish invented model Usage
- **AND** it MUST NOT call `getContextUsage()` merely because the Tool completed

#### Scenario: Ordinary Claude Turn reaches terminal

- **WHEN** an accepted Claude Turn reaches its authoritative terminal
- **THEN** the Adapter MUST calibrate Session Usage from the native Result when available
- **AND** it MUST NOT call `getContextUsage()` merely because the Turn completed

#### Scenario: User explicitly requests exact context

- **WHEN** the current Claude Session receives an explicit exact Usage refresh and the active Query returns valid current context used and maximum Token values
- **THEN** the Adapter MUST publish one `session.usage.changed` snapshot containing the exact `contextUsedTokens` and `contextWindowTokens`
- **AND** the exact observation MUST replace an older context estimate while preserving other still-applicable Session Usage fields

#### Scenario: Claude context response is unavailable or malformed

- **WHEN** an explicit stable context operation fails, returns no current context, or returns an invalid Token pair
- **THEN** the Adapter MUST omit that observation and preserve the latest still-applicable Usage or `null`
- **AND** the Turn outcome, Session health, and bounded close MUST remain unchanged

#### Scenario: Claude Session has not started a Query

- **WHEN** a create or resume Session has not accepted its first Turn
- **THEN** `initialUsage` MUST remain `null`
- **AND** the Adapter MUST NOT start Claude Code only to obtain Usage

#### Scenario: An older context read completes after a newer boundary

- **WHEN** a context read started for an earlier generation completes after the effective Model changes, another Session replaces it, Session close begins, or the Session faults
- **THEN** the Adapter MUST discard that stale result
- **AND** it MUST NOT replace Usage owned by the newer Session boundary

## ADDED Requirements

### Requirement: Claude Code publishes passive request Usage once per actual model response

For every validated complete Root Assistant model response, the Claude Code Adapter MUST consume the response's structured request Usage without issuing another model or token-counting request. The private observation MUST retain a stable request identity, actual request Model, optional structured Provider identity when available, input Token, output Token, cache-creation input Token, and cache-read input Token fields. Request observations, Model/Provider pricing inputs, and deduplication identities MUST remain inside the Claude Adapter package and the owning `ClaudeHarnessSession`.

#### Scenario: Root Assistant response completes before a Tool loop finishes

- **WHEN** a complete Root Assistant response contains reliable request Usage and a Tool or later Assistant response remains pending
- **THEN** the Adapter MUST immediately merge that request into the active Session Usage estimate and publish an update associated with the active Turn
- **AND** it MUST NOT wait for the final Result before updating latest cache hit, Token totals, or a priceable cost estimate

#### Scenario: Complete Assistant frame is delivered more than once

- **WHEN** live transport, replay, or Transcript fallback delivers the same native Assistant request identity more than once
- **THEN** the owning Session MUST count that request at most once
- **AND** duplicate delivery MUST NOT increase Token or cost estimates

#### Scenario: Two Claude Sessions run concurrently

- **WHEN** Session A and Session B receive interleaved Assistant responses, including equal-looking Token values or message-local ordinals
- **THEN** each Session MUST update only its own request set and Usage snapshot
- **AND** neither Session's input, output, cache hit, cost, request identity, or Context state MUST appear in the other Session

#### Scenario: Actual request Model differs from the selected UI Model

- **WHEN** Claude reports that a completed request used a different actual Model or Provider than the currently displayed selectable Model
- **THEN** any request cost estimate MUST use the actual structured request attribution
- **AND** the Adapter MUST NOT price that request using the UI selection alone

#### Scenario: Request cannot be priced reliably

- **WHEN** request Token usage is valid but its actual Model/Provider cannot be mapped to a reliable Adapter-owned price
- **THEN** the Adapter MUST still update reliable Token and cache-hit fields
- **AND** it MUST omit that request's cost increment rather than guessing a price

### Requirement: Claude Code calibrates active-Turn estimates with authoritative Result Usage

Each Claude Session MUST maintain an in-memory calibrated Session baseline plus deduplicated completed-request deltas for the active Turn. A request delta MAY provide near-real-time input, output, cache-hit, context, and cost estimates. When the authoritative native Result provides valid cumulative `modelUsage` or `total_cost_usd`, the Adapter MUST replace the corresponding temporary aggregate with the Result value and clear the calibrated Turn delta. `result.usage` MUST remain latest-request data and MUST NOT be copied into Session aggregate input/output fields.

#### Scenario: Long-running Turn contains multiple model responses

- **WHEN** a Claude Turn completes two or more distinct Root Assistant requests before its terminal Result
- **THEN** the Session MUST publish monotonically merged estimates after each completed request
- **AND** Tool execution between those requests MUST NOT add Tokens or cost by itself

#### Scenario: Result provides cumulative model Usage and cost

- **WHEN** the Turn Result contains valid per-model `modelUsage` and finite non-negative `total_cost_usd`
- **THEN** the Adapter MUST publish Session input/output totals summed from `modelUsage` and Session cost from `total_cost_usd`
- **AND** those authoritative fields MUST replace the corresponding active-Turn estimates without double counting

#### Scenario: Result omits one aggregate field

- **WHEN** the Turn Result provides a valid cumulative cost but no valid cumulative Token totals, or valid Token totals but no valid cost
- **THEN** the Adapter MUST calibrate only the field supplied by the Result
- **AND** it MUST preserve the still-applicable estimate for the omitted field rather than replace it with zero

#### Scenario: Model selection changes between Turns

- **WHEN** an Idle Session selects a different Model after one Turn completes and then starts another Turn
- **THEN** the next Turn's request estimates MUST use each new request's actual Model attribution
- **AND** the previous calibrated Session baseline MUST remain part of the same Session total

#### Scenario: Session closes or faults before Result calibration

- **WHEN** Session close or fault occurs while an estimated Turn has not received an authoritative Result
- **THEN** the uncalibrated state MUST remain memory-only and be discarded with the Session
- **AND** the Adapter MUST NOT persist or transfer it to a replacement Session

### Requirement: Claude exact Context refresh is bounded and deduplicated per Session

A Claude Session MUST coordinate explicit exact Context refreshes with one Session-local in-flight operation, a short success TTL, a failure cooldown, bounded retry delays, and Session/Model generation checks. A successful valid response MUST terminate the retry sequence immediately. Different Claude Sessions MUST NOT share Context in-flight state, TTL entries, cooldowns, or results.

#### Scenario: Concurrent detail requests target one Session

- **WHEN** two or more exact Usage refreshes target the same live Claude Session while one Context read is pending
- **THEN** they MUST share the same in-flight Context operation
- **AND** the Transport MUST NOT receive one `getContextUsage()` call per caller

#### Scenario: Context read succeeds on the first attempt

- **WHEN** the first exact Context attempt returns a valid used/max Token pair
- **THEN** the Adapter MUST publish that observation and stop the retry loop
- **AND** later configured retry delays MUST NOT invoke `getContextUsage()` again

#### Scenario: Exact Context refresh fails repeatedly

- **WHEN** an exact Context refresh throws, returns `null`, or returns malformed data through all bounded attempts
- **THEN** the Session MUST enter a failure cooldown during which repeated detail requests do not start another Context operation
- **AND** the latest still-applicable Usage and Session lifecycle MUST remain unchanged

#### Scenario: Exact Context cache is still fresh

- **WHEN** another exact refresh is requested within the successful Context TTL and the Session/Model generation is unchanged
- **THEN** the Adapter MUST reuse the cached exact observation
- **AND** it MUST NOT call the Transport again

#### Scenario: Two Sessions request exact Context concurrently

- **WHEN** Session A and Session B request exact Context at the same time
- **THEN** each Session MUST use its own in-flight operation and generation checks
- **AND** a result from Session A MUST NOT satisfy or overwrite Session B

### Requirement: Claude plan limits use passive stable events only

Claude.ai five-hour and seven-day plan windows MUST be accepted only from validated SDK `rate_limit_event` observations and MAY be shared at Claude Adapter account scope. The Adapter MUST NOT call the SDK experimental Session Usage operation, read OAuth credentials, or issue direct Anthropic Usage HTTP requests to fill missing plan windows. Missing windows MUST remain absent.

#### Scenario: Stable plan-window event arrives

- **WHEN** a validated `rate_limit_event` reports a five-hour or seven-day utilization window
- **THEN** the Adapter MUST merge the account-scoped window according to existing freshness rules
- **AND** active Claude Sessions MAY publish the accepted value with their own Session Usage snapshots

#### Scenario: No plan-window event has arrived

- **WHEN** Renderer inspects a Claude Thread before any valid plan-window event exists
- **THEN** the Adapter MUST omit the plan-window fields
- **AND** it MUST NOT invoke an experimental Usage operation to manufacture them
