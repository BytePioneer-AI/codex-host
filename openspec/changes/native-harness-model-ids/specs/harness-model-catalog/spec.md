# Spec Delta

## MODIFIED Requirements

### Requirement: Model references preserve exact Adapter-owned identity
A `HarnessModelRef` SHALL be opaque outside its owning Adapter, SHALL be stable for the same native Model identity, and SHALL distinguish every native Model the Harness can select. Its ID SHALL accept any non-empty string of at most 512 UTF-16 code units without control characters. When one native value identifies the Model, the Adapter SHALL use that native value unchanged as the Ref ID.

#### Scenario: Two Providers expose the same Model ID
- **WHEN** Pi returns the same Model ID for two different Providers
- **THEN** PiAdapter emits two different Model Refs and labels that allow the user to distinguish the entries

#### Scenario: Native identity contains separators
- **WHEN** a Provider or Model ID contains `/`, `-`, `.`, or another valid native separator
- **THEN** PiAdapter round-trips the exact pair without separator replacement or guessed parsing

#### Scenario: Catalog contains exact duplicates
- **WHEN** Pi returns the same Provider and Model ID pair more than once
- **THEN** PiAdapter emits one entry for that pair and returns all entries in deterministic order

#### Scenario: Single-value native ID is used as-is
- **WHEN** a single-value Harness such as Codex, Qwen Code, or Hermes reports a native Model ID such as `xai/grok-4.6`, `GLM-5.3-flash(openai)`, or `模型 A`
- **THEN** the Catalog entry's Ref ID equals that native ID exactly, and selecting it sends that native ID to the Harness

#### Scenario: Control characters are rejected
- **WHEN** a Ref ID is empty, longer than 512, or contains a control character such as a newline
- **THEN** the Ref is rejected as invalid at the contract boundary

## ADDED Requirements

### Requirement: Model selection carries an explicit service tier
A Model Ref SHALL carry an optional service tier, separate from the ID, for Harnesses that offer speed tiers of the same Model. Two Refs SHALL be the same selection only when ID and tier both match. Codex Fast and Ultrafast SHALL use the tier field, and a Catalog fast variant SHALL share its standard entry's ID.

#### Scenario: Codex Fast uses the tier field
- **WHEN** the Codex Catalog advertises Fast for `gpt-6.2-sol`
- **THEN** the standard entry's Ref is `gpt-6.2-sol` with no tier and its fast variant is `gpt-6.2-sol` with the priority tier

#### Scenario: Literal suffix stays part of the ID
- **WHEN** a native Model ID itself ends with `~fast`
- **THEN** its Ref ID keeps that suffix and carries no tier

#### Scenario: CLI shorthand resolves to the tier field
- **WHEN** a delegation request passes `--model gpt-6.2-sol~fast` and the Catalog advertises Fast for `gpt-6.2-sol`
- **THEN** the Host selects `gpt-6.2-sol` with the priority tier; without that advertised tier the whole value is treated as the native ID

### Requirement: Route carriers round-trip any valid Model identity
Every carrier that transports a Model selection through Desktop or Web, including draft creation, scheduled tasks, Web Thread creation and Host recovery, SHALL round-trip any valid Model Ref, tier, Thinking option and Permission mode exactly. A carrier SHALL accept the longest valid Ref together with its other fields, and SHALL NOT split a Model identity on characters that the Ref may contain.

#### Scenario: Separator characters inside a Model ID
- **WHEN** a draft is created with a Model whose ID contains `@`, `/`, or `:` together with a Thinking option
- **THEN** the created Thread uses exactly that Model ID and that Thinking option

#### Scenario: Non-ASCII Model ID
- **WHEN** a Thread is created, restored after a Host restart, or scheduled with a Model ID containing non-ASCII characters
- **THEN** the Harness receives the identical ID with no character substitution

#### Scenario: Longest valid Ref is persisted
- **WHEN** a Thread switches to a Model whose Ref ID is 512 code units long
- **THEN** the switch is both applied and saved, and the Model is restored after a Host restart

### Requirement: Previously stored Model Refs remain readable
Refs saved in an earlier encoded form, including encoded Codex Refs with tier prefixes, SHALL be read and normalized to the current form wherever a stored selection is used: preferences, favorites, delegation defaults, Thread records, and delegation deduplication. Reads SHALL NOT rewrite files. A stored legacy value whose native identity cannot be determined uniquely SHALL be treated as unavailable rather than guessed.

#### Scenario: Encoded Codex default still applies
- **WHEN** the saved delegation default is the encoded Codex Fast Ref for `gpt-6.2-sol`
- **THEN** delegation uses `gpt-6.2-sol` with the priority tier, and Settings shows that selection as current

#### Scenario: Retried delegation with an encoded Ref
- **WHEN** a delegation is retried with the same request ID, once with the encoded Ref and once with the native ID for the same Model and tier
- **THEN** both are treated as the same request

#### Scenario: Ambiguous legacy Qwen alias
- **WHEN** a stored Qwen Ref was a character-replaced alias that matches no single current native ID
- **THEN** the saved selection is treated as unavailable and the Harness default applies, without an error that blocks the Thread
