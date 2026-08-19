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

### Requirement: Host validates and routes registered commands

The Host MUST obtain the current Harness command catalog before execution, MUST reject unknown command IDs, and MUST validate arguments at the command boundary. The Host MUST NOT provide an arbitrary native RPC passthrough.

#### Scenario: Unknown command is rejected

- **WHEN** a command execution request references an ID absent from the current catalog
- **THEN** the Host rejects the request
- **AND** no native Harness operation is started

### Requirement: Native command semantics remain inside the owning Adapter

The Adapter MUST translate a registered command into the Harness-native operation and MUST translate native success, failure, cancellation, and busy states into Host-facing results or events. Shared layers MUST NOT contain Harness-specific RPC details.

#### Scenario: Pi compact uses native RPC

- **WHEN** `pi.compact` is executed
- **THEN** the Pi Adapter sends Pi's native `compact` request
- **AND** it does not send `/compact` as a normal Prompt

### Requirement: Command UI and lifecycle follow Host contracts

A command MAY be discovered by the Renderer through the Host command catalog. If execution produces visible lifecycle events, those events MUST use existing Host projection contracts. Temporary command projection Turns MUST NOT be persisted as ordinary conversation history unless the command explicitly requires persistence.

#### Scenario: Manual compaction is projected without a user Turn

- **WHEN** Pi emits native compaction start and end events for `pi.compact`
- **THEN** codexhost projects the standard context-compaction UI lifecycle
- **AND** the temporary command Turn is not added to ordinary Thread history

### Requirement: Commands remain isolated by Harness ownership

The Renderer and Host MUST expose only commands belonging to the current external Harness Thread. A command registered by one Harness MUST NOT appear or execute in another Harness Thread.

#### Scenario: Pi command is hidden from Codex Threads

- **WHEN** the current Thread is owned by Codex rather than Pi
- **THEN** the Pi command catalog is not exposed or rendered
