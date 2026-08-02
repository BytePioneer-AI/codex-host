## MODIFIED Requirements

### Requirement: Claude Adapter exposes native AskUserQuestion as a Host Question

The Claude Code Adapter SHALL enable Claude Code's native `AskUserQuestion` Tool and SHALL map only validated native invocations of that Tool into `HostQuestionInteraction`. It SHALL NOT register a codexhost Question Tool or classify ordinary Tool permission callbacks as Question; validated ordinary Tool callbacks SHALL use the separate Claude Approval capability.

#### Scenario: Claude asks one choice Question

- **WHEN** native Claude Code invokes `AskUserQuestion` during an active Turn with a valid question and options
- **THEN** the Adapter SHALL emit a Question owned by that Host Turn with stable Host Question and Interaction IDs
- **AND** option labels and descriptions SHALL be preserved without exposing native callback IDs

#### Scenario: Claude asks multiple or multi-select Questions

- **WHEN** native Claude Code invokes `AskUserQuestion` with multiple valid questions or `multiSelect: true`
- **THEN** the Adapter SHALL preserve Question order, per-question cardinality, and Other availability
- **AND** unsupported preview presentation SHALL be omitted rather than encoded as opaque native data

#### Scenario: A non-Question permission callback arrives

- **WHEN** the SDK invokes a validated permission callback for a Tool other than `AskUserQuestion`
- **THEN** the Claude transport SHALL route it through the separate bounded Approval capability without emitting a Host Question
- **AND** it SHALL NOT automatically allow the Tool or infer Question from text

#### Scenario: A malformed non-Question callback arrives

- **WHEN** an ordinary Tool permission callback cannot satisfy the bounded Approval validation
- **THEN** the Claude transport SHALL deny it without emitting Question or Approval
- **AND** it SHALL NOT alter another native callback

### Requirement: Claude Question capability remains bounded to native behavior

This slice SHALL expose only Claude Code's native `AskUserQuestion` as a Host Question. It SHALL preserve Claude Code's inherited default Tool set, route validated ordinary permission callbacks only through the separate bounded Approval capability, and SHALL not opt into opaque SDK dialogs or elicitation.

#### Scenario: Claude SDK Query starts

- **WHEN** the Adapter creates its SDK Query
- **THEN** the Query SHALL omit a codexhost Tool override and inherit Claude Code's native Tool set
- **AND** the Query SHALL use the existing permission mode and `canUseTool` callback for native Question and bounded Approval routing
- **AND** no codexhost-owned Tool, `onUserDialog`, or `onElicitation` capability SHALL be registered

#### Scenario: Question data crosses package boundaries

- **WHEN** a Claude Question is emitted and answered
- **THEN** complete native request IDs and SDK payloads SHALL remain inside `packages/adapters/claude-code`
- **AND** prompts and answers SHALL not enter diagnostics, Mapping Store, committed Fixtures, or ordinary test output
