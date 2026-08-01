# claude-code-text-session Specification

## Purpose
Define the development-gated Claude Code Adapter contract for lazy create and resume, deterministic Native history Snapshot reads, text Turns, cancellation, faults, and bounded close without exposing Claude SDK details outside the Adapter package.
## Requirements
### Requirement: Claude Code implements the existing HarnessAdapter contract
The system SHALL provide a concrete Claude Code Adapter that exposes the existing UI-independent create, resume, history Snapshot, text Turn, cancel, fault, and close semantics. Claude SDK objects, message types, settings, process handles, and native protocol fields MUST remain inside the Adapter package.

#### Scenario: Host opens a Claude create Session
- **WHEN** a caller opens a create-mode Session with a valid cwd
- **THEN** the Adapter SHALL return a HarnessSession with Harness ID `claude-code`
- **AND** it SHALL NOT start Claude Code or create an empty Native Session

#### Scenario: Ordinary tests run
- **WHEN** repository formatting, lint, typecheck, build, or normal tests run
- **THEN** Fake Transport tests SHALL exercise the Adapter contract
- **AND** no test SHALL launch Claude Code, read user authentication, create Native Sessions, or consume model quota

### Requirement: Claude inspection separates installation from Model support
The Claude Code Adapter SHALL inspect its configured user executable and, when available, start one no-Prompt official Agent SDK Query using the same cwd, environment, and setting sources as production to read the initialization Model list and stable actual-Model state. It SHALL normalize only validated Model control data, close all owned resources before resolving, and SHALL NOT create a persistent Native Session or call a model endpoint. Lack of proven Model operations MUST NOT by itself report an installed Harness as unavailable.

#### Scenario: Claude executable is resolvable
- **WHEN** Claude inspection resolves the configured executable
- **THEN** the Adapter performs the no-Prompt capability inspection and returns either a ready selectable Catalog or ready empty Catalog according to the structured runtime result
- **AND** it does not create a model Turn or persistent Native Session

#### Scenario: Claude executable exposes a valid Model catalog
- **WHEN** Claude inspection receives valid selectable Model information and current actual-Model readback
- **THEN** the Adapter returns ready inspection with a non-empty deterministic Catalog, a default Ref, optional resolved labels, and `configuration.selectModel=true`
- **AND** it keeps `configuration.selectThinkingOption=false`

#### Scenario: Host startup prefetches the Claude Catalog
- **WHEN** production Host composition registers the Claude Adapter
- **THEN** it starts one background no-Prompt inspection without waiting before starting official Codex routing
- **AND** a later same-cwd inspection reuses the in-flight or successful memory cache
- **AND** missing, unavailable, or failed Claude inspection does not block Codex/Pi startup

#### Scenario: Claude executable lacks required Model operations
- **WHEN** Claude Code initializes but its compatible SDK surface cannot provide a valid selectable Catalog, setter capability, or stable actual-Model readback
- **THEN** the Adapter returns ready inspection with an empty Model catalog and `configuration.selectModel=false`
- **AND** it does not infer support from a version string, settings file, Model name, or description

#### Scenario: Claude executable is missing
- **WHEN** Claude inspection cannot resolve the configured executable
- **THEN** the Adapter returns a normalized `notInstalled` inspection
- **AND** it does not defer that known failure to a created Host Thread

#### Scenario: Claude inspection closes without a Prompt
- **WHEN** successful or failed Model inspection settles
- **THEN** every owned Query and Claude process exits before the result resolves
- **AND** official Session lookup reports no created Native Session

### Requirement: Claude startup is lazy and Native identity is confirmed
The first accepted text Turn SHALL resolve the user-installed Claude Code executable, initialize one long-lived Agent SDK Query with an optional Adapter-owned selectable Model Ref, publish one Native Session Ref and confirmed Model state before that Turn lifecycle, and later reuse the same Query and Native Session. Opening a create or resume Session without a Turn SHALL remain process-free even when create carries a Model Ref.

#### Scenario: Unused Claude Session closes
- **WHEN** a Claude HarnessSession closes without a Turn
- **THEN** no Claude process or Native Session is created

#### Scenario: Claude is not installed
- **WHEN** the first Turn cannot resolve an executable user installation
- **THEN** the command fails before acceptance with `notInstalled`
- **AND** no Turn or Item lifecycle is emitted

#### Scenario: First Turn uses the selected concrete Model
- **WHEN** create input carries a valid Claude Model Ref and the first Turn starts
- **THEN** the Adapter decodes the exact SDK selectable value, initializes the long-lived Query with it, reads stable actual Model state, and emits complete Session state before `turn.started`

#### Scenario: First Turn uses Claude default
- **WHEN** create input uses the Claude default Ref or omits an explicit Ref
- **THEN** the Adapter omits a fixed Model override and publishes the actual Model resolved by Claude Code's current default policy

#### Scenario: Two sequential Turns run
- **WHEN** one Session accepts and completes two text Turns
- **THEN** one SDK Query and one Native Session serve both Turns
- **AND** each caller-assigned User UUID is submitted once

### Requirement: Claude Native history maps deterministically

`readSnapshot()` SHALL read only the identified Native Session through the official Claude SDK history API and SHALL deterministically map each human User message and its following Assistant text messages into one Host Turn. The caller-assigned User UUID SHALL remain the Native Turn identity. Claude Tool-result User messages SHALL remain within their owning Turn and SHALL NOT become synthetic human inputs. codexhost SHALL NOT persist a second Transcript.

#### Scenario: Completed Claude history is read repeatedly
- **WHEN** a Claude Session containing completed text Turns is read more than once
- **THEN** every read SHALL return the same ordered Native Turn identities, inputs, Agent Message identities, text, and outcomes
- **AND** the read SHALL NOT start a Claude Query or emit live Session outputs

#### Scenario: Native Tool messages occur within a Turn
- **WHEN** Assistant Tool use and User Tool-result messages occur between a human User message and the terminal Assistant message
- **THEN** those messages SHALL remain within the same historical Turn
- **AND** only currently supported Assistant text SHALL be projected as historical Items

#### Scenario: Native history omits complete Result evidence
- **WHEN** official history contains Assistant messages but not the complete Result fields required by Claude live terminal classification
- **THEN** the historical Turn outcome SHALL remain `unknown`
- **AND** the Adapter SHALL NOT infer success from Assistant `stop_reason` alone

#### Scenario: Native history identity is inconsistent
- **WHEN** history contains a mismatched Session identity, duplicate message identity, or malformed conversation message
- **THEN** `readSnapshot()` SHALL fail with a normalized protocol error
- **AND** no partial Snapshot SHALL be returned

### Requirement: Claude resume preserves Native Session identity

`open(resume)` SHALL bind the exact persisted Claude Native Session Ref without starting a Query. It SHALL expose that Ref in initial Session state, read current Native history before Host restoration completes, and start a Query with the official SDK `resume` option only when a later Turn is submitted. Claude Fork SHALL remain explicitly unsupported and both Fork capabilities SHALL remain false.

#### Scenario: Host restores a persisted Claude Thread
- **WHEN** Host opens a valid Claude Native Session Ref in resume mode and reads its Snapshot
- **THEN** the Adapter SHALL return the current Native history without creating a replacement Session
- **AND** the next accepted Turn SHALL continue that same Native Session

#### Scenario: Resumed Native Session is missing
- **WHEN** official history reading returns no messages for a resumed Native Session Ref
- **THEN** the Adapter SHALL return `sessionNotFound`
- **AND** it SHALL NOT start a Query or create a replacement Session

#### Scenario: Caller requests Claude Fork
- **WHEN** a caller invokes `open(fork)`
- **THEN** the Adapter SHALL return `unsupported`
- **AND** source history SHALL remain unchanged

### Requirement: Claude text streaming has one complete ordered lifecycle
Every accepted Claude text Turn SHALL emit one Turn start, one Agent Message start, ordered non-duplicated text append updates, one Item terminal, and one Turn terminal. Unknown native message types and non-text content MUST NOT cross the HarnessAdapter seam.

#### Scenario: Partial text and full Assistant agree
- **WHEN** SDK partial events stream a text prefix and the complete Assistant message contains that prefix plus a suffix
- **THEN** the Adapter SHALL append each character exactly once
- **AND** it SHALL append only the missing suffix from the complete message

#### Scenario: Streaming is unavailable
- **WHEN** no partial text event is emitted but a complete Assistant text message arrives
- **THEN** the Adapter SHALL publish that complete text once before the Item terminal

#### Scenario: Native text conflicts
- **WHEN** a complete Assistant text cannot be reconciled with text already emitted for the Turn
- **THEN** the Item and Turn SHALL fail exactly once
- **AND** the Adapter SHALL NOT replay or replace the visible text silently

### Requirement: Claude Result classification uses complete native evidence
A Claude Turn SHALL succeed only when the complete Result and Assistant evidence prove completion. The Adapter MUST inspect `subtype`, `is_error`, `terminal_reason`, Assistant error, and local cancel state rather than trusting one discriminant.

#### Scenario: Nominal success contains native error evidence
- **WHEN** a Result has `subtype=success` but `is_error=true`, a non-completed terminal reason, or an Assistant error
- **THEN** the Adapter SHALL complete the Turn as failed
- **AND** it SHALL map authentication evidence to `authenticationRequired` where applicable

#### Scenario: Successful Result completes
- **WHEN** the Result is non-error, completed, and has no Assistant error
- **THEN** the Agent Message and Turn SHALL complete succeeded exactly once

### Requirement: Claude cancellation waits for authoritative Result
A successful `turn.cancel` SHALL call SDK Interrupt but SHALL not terminate the Host Turn until native Result evidence arrives. Repeated cancel requests SHALL be idempotent, and the same Session SHALL remain reusable after proven cancellation.

#### Scenario: Streaming Turn is cancelled
- **WHEN** Interrupt is accepted for the active Turn and native Result ends with `aborted_streaming` or `aborted_tools`
- **THEN** every started Item SHALL complete cancelled before one `turn.completed(cancelled)`

#### Scenario: Abort cannot be proven
- **WHEN** Interrupt rejects, times out, the process exits, or Result does not carry a proven aborted terminal
- **THEN** the Turn SHALL fail rather than report cancelled

#### Scenario: Turn follows cancellation
- **WHEN** a cancelled Turn reaches its terminal event and the Query remains healthy
- **THEN** the same Session SHALL accept and complete a later text Turn

### Requirement: Claude close and faults are bounded and private
Session and Adapter close SHALL be idempotent, reject new commands after closing begins, terminate owned direct Claude processes within configured bounds, and preserve Native Session history. Unrecoverable Query or process faults SHALL finalize active lifecycles before `session.faulted` and stream end.

#### Scenario: Adapter closes multiple Sessions
- **WHEN** Adapter close is called more than once
- **THEN** every opened Session SHALL close once
- **AND** all calls SHALL converge on the same bounded result

#### Scenario: Query faults during an accepted Turn
- **WHEN** the SDK iterator or owned Claude process fails before an authoritative Result
- **THEN** the Item and Turn SHALL fail exactly once before `session.faulted`
- **AND** raw SDK errors, Prompt text, credentials, and native frames SHALL not enter Host outputs

### Requirement: Claude package root exposes only production Adapter ownership
The Claude Code Adapter package root SHALL directly export only the concrete Adapter, its production options, and package metadata. It SHALL NOT directly re-export Claude SDK transport interfaces, native message accumulators, executable helpers, or test dependency types.

#### Scenario: Production Host imports Claude Adapter
- **WHEN** Host composition imports the Claude package root
- **THEN** it SHALL consume only ClaudeCodeAdapter and package metadata
- **AND** no Claude SDK message or transport type SHALL enter Host production code

#### Scenario: Adapter tests inject a fake transport
- **WHEN** Claude Adapter tests need deterministic native behavior
- **THEN** they SHALL use package-internal test seams
- **AND** the production package root SHALL not expand for that test

### Requirement: Claude Code publishes stable current context Usage

The Claude Code Adapter MUST read current context Usage only from the active official SDK Query's stable structured context operation. It MUST map reliable current used Token and effective maximum Token values into one normalized `HostUsage` context pair after a Turn terminal, and MUST omit unavailable Session aggregate, cost, category, percentage, or Model fields rather than deriving them. It MUST NOT depend on the SDK experimental Session Usage operation or interpret per-Result Usage as a Native Session aggregate.

#### Scenario: Successful Claude Turn exposes current context

- **WHEN** an accepted Claude Turn reaches its authoritative terminal and the active Query returns valid current context used and maximum Token values
- **THEN** the Adapter MUST publish one `session.usage.changed` snapshot containing the corresponding `contextUsedTokens` and `contextWindowTokens`
- **AND** the snapshot MUST remain Session-level Telemetry associated with that observation boundary

#### Scenario: Claude context response is unavailable or malformed

- **WHEN** the stable context operation fails, returns no current context, or returns an invalid Token pair
- **THEN** the Adapter MUST omit that observation and preserve the latest still-applicable Usage or `null`
- **AND** the Turn outcome, Session health, and bounded close MUST remain unchanged

#### Scenario: Claude Session has not started a Query

- **WHEN** a create or resume Session has not accepted its first Turn
- **THEN** `initialUsage` MUST remain `null`
- **AND** the Adapter MUST NOT start Claude Code only to obtain Usage

#### Scenario: An older context read completes after a newer boundary

- **WHEN** a context read started for an earlier Turn completes after another Turn starts, Session close begins, or the Session faults
- **THEN** the Adapter MUST discard that stale result
- **AND** it MUST NOT replace Usage owned by the newer Session boundary

### Requirement: Claude Catalog uses official runtime data without configuration parsing
Claude Adapter SHALL derive selectable identity from official SDK `ModelInfo.value`, optional initial resolved display from structured SDK fields, and current actual display from stable structured current-context Model readback. It MUST NOT read `settings.json`, maintain a static first-party manifest, parse human descriptions, or advertise Models absent from the runtime Catalog.

#### Scenario: User maps Claude aliases to a custom Model
- **WHEN** the user's Claude Code configuration maps family aliases to GLM, MiniMax, Bedrock, or another compatible Model and the SDK exposes those resolved choices
- **THEN** inspection shows the SDK-provided selectable values and resolved labels
- **AND** it does not append unrelated hardcoded Sonnet, Opus, or Haiku versions

#### Scenario: Runtime returns sensitive Model metadata
- **WHEN** initialization also contains account, Provider, pricing, endpoint, path, credential, or unknown fields
- **THEN** Claude Adapter discards those fields before constructing the public Catalog

### Requirement: Claude Model selection uses setter plus stable actual readback
A started Claude Session SHALL support `model.select` only while Idle. The Adapter SHALL decode only its own Ref, call the official SDK Model setter, read the stable current actual Model, publish the complete selectable and resolved state, and only then complete the command.

#### Scenario: Idle selection resolves to a custom Model
- **WHEN** an Idle Session selects a family alias that Claude Code maps to a custom Model
- **THEN** Session state retains the alias Ref and reports the custom actual Model as `resolvedModelLabel`

#### Scenario: Default selection is restored
- **WHEN** an Idle Session selects the Adapter default Ref
- **THEN** Claude Adapter clears the explicit SDK Model override and publishes the actual default Model returned by readback

#### Scenario: Setter rejects selection
- **WHEN** the SDK rejects an unavailable or policy-disallowed selectable value before any uncertain write
- **THEN** the Adapter returns an explicit native failure and preserves the prior confirmed state

#### Scenario: Setter succeeds but readback fails
- **WHEN** the setter may have changed the Model and stable actual-Model readback is unavailable or malformed
- **THEN** the Adapter faults the Session rather than execute a later Turn under unknown Model state

### Requirement: Claude Thinking selection remains unsupported
Claude Adapter SHALL keep `configuration.selectThinkingOption=false` and SHALL reject `thinking.select` even when ModelInfo reports supported effort levels. It MUST NOT report a requested effort as effective without a stable structured Session readback proving the actual value.

#### Scenario: Catalog Model reports effort levels
- **WHEN** official ModelInfo reports one or more shape-valid supported effort level IDs, including an ID codexhost has not seen before
- **THEN** the Adapter may preserve those runtime IDs without a Claude-specific semantic allowlist or fixed label mapping and keeps each Model's supported set distinct
- **AND** Renderer does not expose a Claude Thinking selector in this Change

#### Scenario: Caller attempts Claude Thinking selection
- **WHEN** a create input or Session command supplies a Claude Thinking option
- **THEN** Claude Adapter returns `unsupported` and performs no native configuration write
