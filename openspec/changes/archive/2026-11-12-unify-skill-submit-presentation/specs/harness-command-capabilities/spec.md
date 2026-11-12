## MODIFIED Requirements

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
