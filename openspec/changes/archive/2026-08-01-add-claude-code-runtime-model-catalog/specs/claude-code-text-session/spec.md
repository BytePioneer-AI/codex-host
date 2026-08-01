## MODIFIED Requirements

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

## ADDED Requirements

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
