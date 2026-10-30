# harness-command-capabilities Specification

## Purpose

Define the small, explicit contract for Harness-specific commands exposed through codexhost.

## Requirements

### Requirement: Commands are explicitly registered by the owning Adapter

A Harness Adapter MUST publish a command catalog containing stable command IDs, invocations, labels, and argument modes. A command MUST NOT be available merely because a native Harness accepts an arbitrary command string.

#### Scenario: Pi exposes compact

- **WHEN** the Pi Adapter lists commands
- **THEN** the catalog contains the registered `pi.compact` command
- **AND** the command declares `/compact` and its supported argument mode

#### Scenario: Claude Code exposes compact

- **WHEN** the Claude Code Adapter lists commands
- **THEN** the catalog contains the registered `claude.compact` command
- **AND** the command declares `/compact` and its supported argument mode

#### Scenario: Claude Code exposes init and recap

- **WHEN** the Claude Code Adapter lists commands
- **THEN** the catalog contains the registered `claude.init` and `claude.recap` commands
- **AND** both commands declare their invocations and argument mode `none`

#### Scenario: DeepSeek exposes only reviewed native commands

- **WHEN** a DeepSeek Session lists Harness commands
- **THEN** the Adapter reads that Session's current native `commands/list` catalog
- **AND** it maps valid advertised entries only to `dsh.compact`, `dsh.goal`, and `dsh.plan`, preserving their native relative order
- **AND** the mapped commands declare `/compact` with argument mode `none`, plus `/dsh-goal` and `/plan` with argument mode `text`
- **AND** `/dsh-goal` maps to native DSH `/goal` without entering Codex Desktop's built-in `/goal` flow
- **AND** it does not expose native `/feedback` because Codex Desktop owns a conflicting built-in command

#### Scenario: DeepSeek native catalog is missing or malformed

- **WHEN** a reviewed command is absent, has an incompatible input descriptor, or the native catalog contains invalid fields, duplicate names, or invalid descriptions
- **THEN** an absent or incompatible command is omitted, while a malformed catalog fails with a protocol error and exposes no partial result
- **AND** codexhost MUST NOT substitute a fixed catalog

#### Scenario: DeepSeek control and future commands remain excluded

- **WHEN** DSH advertises `permission`, `export`, or an unknown future command, or the Client contributes `/model`
- **THEN** none is exposed as a normal Harness command
- **AND** Permission Mode and Model selection remain on their existing first-class controls

### Requirement: Host validates and routes registered commands

The Host MUST obtain the current Harness command catalog before execution, MUST reject unknown command IDs, and MUST validate arguments at the command boundary. The Host MUST NOT provide an arbitrary native RPC passthrough.

#### Scenario: Unknown command is rejected

- **WHEN** a command execution request references an ID absent from the current catalog
- **THEN** the Host rejects the request
- **AND** no native Harness operation is started

#### Scenario: Unmatched slash input fails closed

- **WHEN** an external Thread submits slash-shaped text that matches no command in its current catalog
- **THEN** Host rejects the submission as an unavailable Harness command
- **AND** it does not send that text as a normal model Prompt or attempt an arbitrary native command

### Requirement: Native command semantics remain inside the owning Adapter

The Adapter MUST translate a registered command into the Harness-native operation and MUST translate native success, failure, cancellation, and busy states into Host-facing results or events. Shared layers MUST NOT contain Harness-specific RPC details.

#### Scenario: Pi compact uses native RPC

- **WHEN** `pi.compact` is executed
- **THEN** the Pi Adapter sends Pi's native `compact` request
- **AND** it does not send `/compact` as a normal Prompt

#### Scenario: Claude compact uses dedicated compact transport

- **WHEN** `claude.compact` is executed
- **THEN** the Claude Adapter calls the dedicated compact transport
- **AND** it does not submit `/compact` as a Host text Turn

#### Scenario: Claude init and recap use dedicated command transport

- **WHEN** `claude.init` or `claude.recap` is executed
- **THEN** the Claude Adapter calls the dedicated init or recap transport
- **AND** it does not submit those invocations as Host text Turns

#### Scenario: DeepSeek commands use the native command Remote

- **WHEN** a reviewed DeepSeek command is executed
- **THEN** the Adapter rechecks the current Session catalog and calls native `commands/execute` with the exact command line and cancellation signal
- **AND** codexhost does not reproduce the command's state changes or send it as a normal Prompt

### Requirement: Command UI and lifecycle follow Host contracts

A command MAY be discovered by the Renderer through the Host command catalog. The Renderer SHALL present discovered commands through an independent Composer Harness Commands control rather than mutating the Codex-native Slash command list. Its popover SHALL own its layout, scrolling, focus, and keyboard navigation. If execution produces visible lifecycle events, those events MUST use existing Host projection contracts. Temporary command projection Turns MUST NOT be persisted as ordinary conversation history unless the command explicitly requires persistence.

#### Scenario: Text command selection claims the Composer

- **WHEN** the user selects a command with argument mode `text` from the Harness Commands popover
- **THEN** Renderer prefixes its invocation and one space to the current Composer editor while preserving the existing draft and attachments
- **AND** the command uses the ordinary Composer submission path instead of executing a bare invocation immediately

#### Scenario: Argument-free command selection executes directly

- **WHEN** the user selects a command with argument mode `none`
- **THEN** Renderer executes that registered command directly through the fixed Host command route

#### Scenario: Manual compaction is projected without a user Turn

- **WHEN** Pi, Grok, Claude Code, or DeepSeek emits native compaction start and end events for its compact command
- **THEN** codexhost projects the standard context-compaction UI lifecycle
- **AND** the temporary command Turn is not added to ordinary Thread history

#### Scenario: DeepSeek command result text uses existing projection

- **WHEN** DeepSeek `/goal` or `/plan` returns native success or error text
- **THEN** codexhost projects the text through the existing Command Execution Item and completes the temporary Turn with the native outcome
- **AND** native log-only command lifecycle records do not become ordinary conversation Turns

### Requirement: Commands remain isolated by Harness ownership

The Renderer and Host MUST expose only commands belonging to the current external Harness Thread. A command registered by one Harness MUST NOT appear or execute in another Harness Thread.

#### Scenario: Pi command is hidden from Codex Threads

- **WHEN** the current Thread is owned by Codex rather than Pi
- **THEN** the Pi command catalog is not exposed or rendered
