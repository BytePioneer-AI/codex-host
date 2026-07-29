# claude-code-question-interaction-session Specification

## Purpose
TBD - created by archiving change implement-claude-code-question-interaction-slice. Update Purpose after archive.
## Requirements
### Requirement: Claude Adapter exposes native AskUserQuestion as a Host Question

The Claude Code Adapter SHALL enable Claude Code's native `AskUserQuestion` Tool and SHALL map only validated native invocations of that Tool into `HostQuestionInteraction`. It SHALL NOT register a codexhost Question Tool or classify ordinary Tool permission callbacks as Question.

#### Scenario: Claude asks one choice Question

- **WHEN** native Claude Code invokes `AskUserQuestion` during an active Turn with a valid question and options
- **THEN** the Adapter SHALL emit a Question owned by that Host Turn with stable Host Question and Interaction IDs
- **AND** option labels and descriptions SHALL be preserved without exposing native callback IDs

#### Scenario: Claude asks multiple or multi-select Questions

- **WHEN** native Claude Code invokes `AskUserQuestion` with multiple valid questions or `multiSelect: true`
- **THEN** the Adapter SHALL preserve Question order, per-question cardinality, and Other availability
- **AND** unsupported preview presentation SHALL be omitted rather than encoded as opaque native data

#### Scenario: A non-Question permission callback arrives

- **WHEN** the SDK invokes the permission callback for a Tool other than `AskUserQuestion`
- **THEN** the Claude transport SHALL deny that unsupported callback without emitting a Host Question
- **AND** it SHALL NOT automatically allow the Tool or infer Approval from text

### Requirement: Claude Question answers return to the exact native callback

The Adapter SHALL correlate Host Interaction ID, native Tool Use ID, native control Request ID, and complete native question text in private in-memory state. It SHALL validate Host responses before resolving the matching SDK callback.

#### Scenario: User answers a Question

- **WHEN** the Host submits a valid response for a pending Claude Question
- **THEN** the Adapter SHALL resolve only the matching native callback with `behavior: "allow"`
- **AND** `updatedInput.answers` SHALL be keyed by complete native question text
- **AND** the response SHALL include the matching native Tool Use ID and temporary-user decision classification

#### Scenario: User answers a multi-select Question

- **WHEN** the Host submits multiple declared values for a native multi-select Question
- **THEN** the Adapter SHALL encode those values as the SDK-documented comma-separated answer string in selection order
- **AND** it SHALL NOT alter another Question or callback

#### Scenario: User enters an Other value

- **WHEN** the Host submits a free-text value for a Question whose native UI allows Other
- **THEN** the Adapter SHALL preserve that value in the matching native answer
- **AND** it SHALL NOT persist or log the value

#### Scenario: User skips the Question

- **WHEN** the Host cancels or dismisses a pending Claude Question
- **THEN** the Adapter SHALL resolve only that native callback with a denied cancellation result
- **AND** the Interaction SHALL close as cancelled without becoming an Approval decision

#### Scenario: Response is invalid or duplicate

- **WHEN** a Host response is malformed, references an unknown or closed Interaction, or violates answer cardinality
- **THEN** the Adapter SHALL return `invalidRequest` or `invalidState`
- **AND** it SHALL NOT resolve or alter any native callback

### Requirement: Claude Question lifecycle converges before Turn terminal

Every exposed Claude Question SHALL appear after `turn.started`, close exactly once, and close before the owning Turn's unique terminal event. Answering a Question SHALL NOT itself complete the Turn.

#### Scenario: Question arrives before ordinary prompt output

- **WHEN** the SDK permission callback occurs before any Assistant stream message
- **THEN** the Adapter SHALL emit it after `turn.started` and allow an immediate response
- **AND** the system SHALL NOT deadlock waiting for later prompt output

#### Scenario: Turn is interrupted during a pending Question

- **WHEN** `turn.cancel` interrupts Claude while `AskUserQuestion` is pending
- **THEN** the SDK Callback AbortSignal SHALL close the Interaction as cancelled exactly once
- **AND** the Adapter SHALL wait for the native Turn result before emitting one Turn terminal

#### Scenario: Session closes or faults during a pending Question

- **WHEN** Session close or SDK transport fault occurs with a pending Claude Question
- **THEN** the Adapter SHALL close the Interaction before Item, Turn, Session, or output-stream terminal processing
- **AND** no callback resolver or native correlation SHALL remain reachable

#### Scenario: Same Session continues after a Question

- **WHEN** one Claude Turn answers a Question and reaches its native terminal
- **THEN** a later Turn SHALL reuse the same Claude Query and native Session
- **AND** no Interaction state from the previous Turn SHALL affect it

### Requirement: Claude Question capability remains bounded to native behavior

This slice SHALL expose only Claude Code's native `AskUserQuestion` as a Host Interaction. It SHALL preserve Claude Code's inherited default Tool set, deny unsupported callbacks that require a human permission decision, and SHALL not opt into opaque SDK dialogs or elicitation.

#### Scenario: Claude SDK Query starts

- **WHEN** the Adapter creates its SDK Query
- **THEN** the Query SHALL omit a codexhost Tool override and inherit Claude Code's native Tool set
- **AND** the Query SHALL use a permission mode and `canUseTool` callback that permit the native Question callback
- **AND** no codexhost-owned Tool, `onUserDialog`, or `onElicitation` capability SHALL be registered

#### Scenario: Question data crosses package boundaries

- **WHEN** a Claude Question is emitted and answered
- **THEN** complete native request IDs and SDK payloads SHALL remain inside `packages/adapters/claude-code`
- **AND** prompts and answers SHALL not enter diagnostics, Mapping Store, committed Fixtures, or ordinary test output
