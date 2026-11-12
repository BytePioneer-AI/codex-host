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

A command MAY be discovered through the Host catalog. Renderer SHALL use an independent Composer control without changing Codex-native Slash lists. Its popover SHALL own layout, scrolling, focus and keyboard navigation. Adapter execution lifecycle MUST distinguish conversation from temporary operation before streaming output is presented. Conversation output SHALL use ordinary messages and native history; temporary operations MUST NOT create conversation history. Directory classification MUST NOT be the sole execution switch. Compact SHALL retain its existing command-acceptance path without waiting for `turn.started`.

#### Scenario: Text command selection claims the Composer

- **WHEN** the user selects a command with argument mode `text`
- **THEN** Renderer preserves the draft and attachments, inserts the invocation reference and uses the ordinary submission path

#### Scenario: Argument-free command selection executes directly

- **WHEN** the user selects a command with argument mode `none`
- **THEN** Renderer executes that registered command directly through the fixed Host command route

#### Scenario: Manual compaction is projected without a user Turn

- **WHEN** an Adapter reports native compaction execution
- **THEN** standard compaction progress and terminal outcome are displayed without adding an ordinary history Turn

#### Scenario: Official Codex compact retains native confirmation

- **WHEN** official Codex accepts `/compact` without returning a Turn ID
- **THEN** the existing native command route confirms acceptance without requiring an external submission receipt
- **AND** native compaction events keep their original presentation without a new correlation protocol or a terminal outcome inferred from another Turn

#### Scenario: DeepSeek command result text uses existing projection

- **WHEN** a reviewed native command returns only operation result text
- **THEN** the existing operation presentation displays the result and outcome without synthesizing native conversation history

#### Scenario: Skill produces a conversation

- **WHEN** a selected Skill starts a native conversation
- **THEN** its user message displays an inline icon and name followed by ordinary body text
- **AND** streaming replies and tools appear below it in conversation order, not inside a command card
- **AND** internal links and source paths are not exposed as Skill labels

#### Scenario: Native invocation remains unchanged

- **WHEN** the same visual Skill reference is submitted to different Harnesses
- **THEN** each Adapter retains its own native invocation and official Codex retains its native Skill input semantics

### Requirement: Commands remain isolated by Harness ownership

The Renderer and Host MUST expose only commands belonging to the current external Harness Thread. A command registered by one Harness MUST NOT appear or execute in another Harness Thread.

#### Scenario: Pi command is hidden from Codex Threads

- **WHEN** the current Thread is owned by Codex rather than Pi
- **THEN** the Pi command catalog is not exposed or rendered
