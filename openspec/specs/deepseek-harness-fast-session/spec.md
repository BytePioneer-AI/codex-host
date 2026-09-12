# deepseek-harness-fast-session Specification

## Purpose
规定 DeepSeek Harness 的公共 Adapter、原生凭据复用、文本/工具输出与取消语义；当前双 RC 历史能力由 support-dsh-015rc1 更新，具体格式边界见 deepseek-versioned-web-protocol。
## Requirements
### Requirement: DeepSeek Harness uses the shared Adapter contract

The system SHALL provide one public `deepseek-harness` implementation of `HarnessAdapter` and `HarnessSession` supporting exact DSH `0.1.2-rc.1` and `0.1.5-rc.1`. DSH Remote methods, event names and version profiles MUST remain internal to that Adapter package.

#### Scenario: New DeepSeek Session opens
- **WHEN** Host opens the DeepSeek Adapter with a create input and an exact supported runtime
- **THEN** the Adapter SHALL return a HarnessSession with a stable Native Session reference
- **AND** native resume, same-cwd fork, and last-turn rollback capabilities SHALL be available under the selected profile's verified boundaries

### Requirement: The runtime reuses the official DSH credential store
The DeepSeek runtime SHALL resolve provider credentials through the official DSH credentials service and its standard Harness home. codexhost MUST NOT parse, copy, return, or persist credential values.

#### Scenario: Web Models page has stored a DeepSeek key
- **WHEN** the Web Models page stored `DEEPSEEK_API_KEY` in the active DSH Harness home
- **THEN** a new codexhost DeepSeek Session SHALL resolve that credential through the DSH credentials service
- **AND** the user SHALL NOT need to export the key again

### Requirement: New Sessions support the primary live turn flow
A DeepSeek Harness Session SHALL accept sequential text Turns and project native text, Reasoning, Tool, structured Diff, and terminal Turn events through standard Harness outputs.

#### Scenario: Native events form a completed turn
- **WHEN** DSH reports turn start, text or Reasoning chunks, Tool events, and turn end
- **THEN** the Session SHALL emit ordered standard Item and Turn events
- **AND** no DSH wire type SHALL escape the Adapter

#### Scenario: Official filesystem tool returns structured diffs
- **WHEN** a completed DSH tool result contains valid `meta.diffs`
- **THEN** the Session SHALL complete a standard File Change item carrying those diffs

### Requirement: Cancellation is real and fail-closed
The Session SHALL map `turn.cancel` to a DSH `session/cancel` RPC and SHALL only accept cancellation when the runtime accepts that request.

#### Scenario: Runtime accepts cancellation
- **WHEN** a live Host Turn is cancelled and DSH accepts `session/cancel`
- **THEN** the Session SHALL accept the cancel command
- **AND** later native turn termination SHALL complete the Host Turn once

#### Scenario: Runtime lacks cancel bridge
- **WHEN** DSH rejects `session/cancel` as unknown
- **THEN** the Session SHALL return a protocol or unsupported failure
- **AND** it SHALL NOT report successful cancellation
