## MODIFIED Requirements

### Requirement: Commands are explicitly registered by the owning Adapter

A Harness Adapter MUST publish a command catalog containing stable command IDs, invocations, labels, and argument modes. A command MUST NOT be available merely because a native Harness accepts an arbitrary command string. Entries enumerated from the Harness's own native discovery interface (for Claude Code: `supportedCommands()` filtered by the initialization response's skill list) are a legitimate source of native availability and MUST be admitted through the Adapter's catalog rather than treated as arbitrary strings. Strings that are absent from every published catalog of the current Thread MUST NOT be executed as commands.

#### Scenario: Pi exposes compact

- **WHEN** the Pi Adapter lists commands
- **THEN** the catalog contains the registered `pi.compact` command
- **AND** the command declares `/compact` and its supported argument mode

#### Scenario: Natively enumerated skill

- **WHEN** the Claude Code Adapter's native enumeration reports an available skill
- **THEN** the skill is eligible for the Thread's Skills catalog
- **AND** this does not count as "available merely because a native Harness accepts a string"

#### Scenario: Unregistered command string is rejected

- **WHEN** an execution request references a `/foo` present in neither catalog of the current Thread
- **THEN** the Host rejects the request
- **AND** no native Harness operation is started

### Requirement: Command UI and lifecycle follow Host contracts

A command MAY be discovered by the Renderer through the Host command catalog. The Renderer SHALL present discovered commands through an independent Composer Harness Commands control rather than mutating the Codex-native Slash command list. A Harness that additionally publishes a Skills catalog SHALL present it through a separate independent Composer Skills control; the two controls MUST NOT merge their entries. Each popover SHALL own its layout, scrolling, focus, and keyboard navigation. If execution produces visible lifecycle events, those events MUST use existing Host projection contracts. Temporary command projection Turns MUST NOT be persisted as ordinary conversation history unless the command explicitly requires persistence.

#### Scenario: Manual compaction is projected without a user Turn

- **WHEN** Pi or Claude Code emits native compaction start and end events for their compact command
- **THEN** codexhost projects the standard context-compaction UI lifecycle
- **AND** the temporary command Turn is not added to ordinary Thread history

#### Scenario: Skills render in their own control

- **WHEN** a Claude Thread has a non-empty Skills catalog
- **THEN** its entries render only in the Skills popover
- **AND** the Harness Commands popover contents are unchanged by the Skills catalog

### Requirement: Commands remain isolated by Harness ownership

The Renderer and Host MUST expose only commands belonging to the current external Harness Thread, including both its Commands catalog and its Skills catalog as two independent collections. Within one Thread the two catalogs MUST NOT contain each other's entries. A command or skill registered by one Harness MUST NOT appear or execute in another Harness Thread.

#### Scenario: Pi command is hidden from Codex Threads

- **WHEN** the current Thread is owned by Codex rather than Pi
- **THEN** the Pi command catalog is not exposed or rendered

#### Scenario: The two Claude catalogs are disjoint

- **WHEN** the Renderer inspects a Claude Thread's commands and skills
- **THEN** static native commands appear only in the Commands catalog
- **AND** natively enumerated skills appear only in the Skills catalog

## ADDED Requirements

### Requirement: Execution route is unified across both catalogs

`codexhost/thread/command/execute` SHALL remain the single execution entry point for both the Commands catalog and the Skills catalog, routing by command ID to the owning Adapter, which dispatches internally. Boundary validation SHALL accept an ID present in either catalog of the current Thread. The Host MUST NOT add a second execution RPC and MUST NOT provide a raw-RPC passthrough for either catalog.

#### Scenario: Skill ID dispatches to the skill executor

- **WHEN** an execution request carries a `claude.skill.`-prefixed ID present in the current Skills catalog
- **THEN** the Claude Adapter dispatches it to the skill executor
- **AND** the Host route is the same `command/execute` method used for static commands

#### Scenario: Static command ID dispatches unchanged

- **WHEN** an execution request carries `claude.compact`
- **THEN** the Claude Adapter dispatches it to the existing dedicated compact transport
