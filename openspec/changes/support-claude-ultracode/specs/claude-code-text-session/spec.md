## REMOVED Requirements

### Requirement: Claude Thinking selection remains unsupported
**Reason**: Claude Thinking selection was implemented in `444e3928` (`configuration.selectThinkingOption=true`, native effort via `query({ effort })` and `applyFlagSettings`), so this requirement no longer describes the product; its scenarios contradict current behavior.

**Migration**: Use the added requirement "Claude Thinking selection uses native effort and session-scoped Ultracode".

## ADDED Requirements

### Requirement: Claude Thinking selection uses native effort and session-scoped Ultracode

Claude Adapter SHALL report `configuration.selectThinkingOption=true` and SHALL expose the Thinking options `off`, `auto`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultracode` for every Model and every Claude Code version. `off` SHALL disable native thinking, `auto` SHALL leave native effort at the Model default, and each effort option SHALL select the native effort level of the same name. `ultracode` SHALL mean native effort `xhigh` plus the session-scoped native `ultracode` flag setting.

Because Claude Code accepts an `ultracode` flag setting it cannot honor, including on versions that predate it, the Adapter SHALL decide whether Ultracode is in effect only by reading the native Session settings back after the write. Ultracode SHALL count as in effect only when the readback reports `applied.ultracode === true`; any other readback, or a readback that cannot be performed, SHALL fail closed. The Adapter SHALL NOT silently substitute another Thinking option.

The Adapter SHALL include the `ultracode` key in a native flag-settings write only when entering or leaving Ultracode: entering SHALL send `{ alwaysThinkingEnabled: true, effortLevel: "xhigh", ultracode: true }`, and leaving SHALL add `ultracode: false` to the next option's existing fields.

#### Scenario: Every Model offers Ultracode

- **WHEN** Claude inspection returns its Model Catalog
- **THEN** every Model's supported Thinking options SHALL include `ultracode` regardless of Claude Code version or native effort metadata

#### Scenario: Ultracode is confirmed before the first message is sent

- **WHEN** a Turn starts a native Session whose Thinking option is `ultracode`
- **THEN** the Query SHALL start with native effort `xhigh`, and after initialization and before writing the user message the Adapter SHALL write the entering settings and read the Session settings back
- **AND** the user message SHALL be written only when the readback confirms Ultracode

#### Scenario: Ultracode cannot be confirmed before sending

- **WHEN** that readback does not confirm Ultracode
- **THEN** the Turn start SHALL fail with an error naming the reason, the user message SHALL NOT be written to Claude Code, and the native process started for it SHALL be closed
- **AND** the saved Thinking option SHALL remain `ultracode`, so the next message reports the same error until the user changes the option or the native prerequisite

#### Scenario: Claude Code predates Ultracode

- **WHEN** the readback has no Ultracode state
- **THEN** the error SHALL be `unsupported`, not retryable, and name Claude Code `2.1.154` as the minimum version

#### Scenario: Dynamic workflows are off

- **WHEN** the readback reports Ultracode unavailable and dynamic workflows are off in the Session settings or Claude Code's environment switches
- **THEN** the error SHALL be `configurationRequired` and direct the user to turn on Dynamic workflows in Claude Code `/config`

#### Scenario: The Model cannot run Ultracode

- **WHEN** the readback reports Ultracode unavailable while dynamic workflows are explicitly on
- **THEN** the error SHALL be `unsupported` and name the selected Model as the cause

#### Scenario: The prerequisite is unknown or the settings are unreadable

- **WHEN** the readback reports Ultracode unavailable or off without saying which prerequisite fails, or the settings cannot be read
- **THEN** the error SHALL be `configurationRequired`, or a retryable `nativeFailure` when unreadable, naming dynamic workflows, Model support, or the minimum version as applicable

#### Scenario: Live selection enters Ultracode

- **WHEN** a started Session selects `ultracode`
- **THEN** the Adapter SHALL write the entering settings, read them back, and publish `ultracode` only after the readback confirms it

#### Scenario: Claude Code does not honor a live Ultracode selection

- **WHEN** the readback after a live selection does not confirm Ultracode
- **THEN** the Adapter SHALL restore the prior option natively, including `ultracode: false`, read the settings back to confirm Ultracode is off, return the reason's error, and keep the prior confirmed Thinking option
- **AND** if that restore fails or its readback still reports Ultracode on, the Session SHALL fault rather than continue with unknown Thinking state

#### Scenario: Live selection leaves Ultracode

- **WHEN** a Session in `ultracode` selects `off`, `auto`, or an effort option
- **THEN** the native write SHALL carry `ultracode: false` in addition to that option's existing thinking and effort fields

#### Scenario: Neither side is Ultracode

- **WHEN** a selection changes between two options that are not `ultracode`
- **THEN** the native write SHALL NOT contain the `ultracode` key and no readback SHALL be made

#### Scenario: Model change cannot keep Ultracode

- **WHEN** a Session in `ultracode` changes Model and the readback after re-entering Ultracode does not confirm it
- **THEN** the Adapter SHALL restore the prior Model and Ultracode, read the settings back to confirm Ultracode is in effect again, keep `ultracode`, and return the reason's error without publishing the new Model
- **AND** if that restore fails or its readback does not confirm Ultracode, the Session SHALL fault rather than continue with unknown Model or Thinking state

#### Scenario: Caller supplies an invalid Thinking option

- **WHEN** a create input or Session command supplies an ID outside the Claude Thinking options
- **THEN** Claude Adapter SHALL return `invalidRequest` and perform no native configuration write

### Requirement: Claude maps Workflow runs to the common Subagent contract

Claude Adapter SHALL map each Root `Workflow` Tool Use to one Host Subagent Delegation Item instead of a Generic Tool Item and SHALL map the `workflow_agent` entries of native `task_progress.workflow_progress` frames correlated by Tool Use ID into that Item's Subagents. A launched run SHALL keep its Item open and SHALL occupy the Host Turn like a background Subagent until its native task settles and the Root continuation finishes. Each Workflow agent SHALL have a stable `subagentId` derived from the Workflow call and the agent index, SHALL gain its `nativeSubagentId` when the native `agentId` is reported, and SHALL expose only bounded common metadata. A Workflow agent with a native `agentId` SHALL be readable as a read-only Child Host Thread through the official `getSubagentMessages()` API. Unknown or malformed progress entries SHALL be ignored without failing the Turn or Session.

#### Scenario: Root launches a Workflow

- **WHEN** a Root Assistant message contains a valid `Workflow` Tool Use
- **THEN** Claude Adapter SHALL start one spawn delegation Item when the first native task frame of that call arrives, with the native task description as its prompt and the Tool input `name` as fallback
- **AND** a Workflow Tool Result that reports an error or no background run SHALL settle that Item from the result

#### Scenario: Workflow progress lists agents

- **WHEN** a correlated `task_progress` frame carries `workflow_agent` entries
- **THEN** each entry SHALL appear as one Subagent in index order with its label as description, its agent type or phase title as role, and its native Model ID as Model
- **AND** a `start` entry without a start time or agent ID SHALL map to pending, `start` and `progress` to running, `done` to completed with the bounded result preview, and `error` to failed with the bounded error

#### Scenario: Workflow agent receives a native identity

- **WHEN** an entry first reports `agentId`
- **THEN** the Subagent SHALL keep its `subagentId` and gain that `nativeSubagentId`, and Host Runtime SHALL be able to open its Child Host Thread from the official transcript
- **AND** the Child Thread's initial prompt SHALL show the computed task without Claude Code's Workflow harness frame when that frame is recognized

#### Scenario: Workflow agents make progress

- **WHEN** an agent's reported state changes, or a correlated `task_progress` frame without `workflow_progress` reports agent activity
- **THEN** Claude Adapter SHALL publish transcript changes for the affected agents, or for every running agent of that run when the frame does not name one, so open Child Threads refresh

#### Scenario: Workflow agent asks for permission

- **WHEN** a Workflow agent's tool requests permission, before or after the Root result
- **THEN** the Approval title SHALL name the agent's label when known, the request SHALL stay pending across the Root Segment terminal while the Host Turn is held, and the user's answer SHALL resolve the native request
- **AND** when the held Host Turn ends or no Host Turn can show the request, the native request SHALL be denied

#### Scenario: Workflow completes

- **WHEN** the Workflow task settles as completed, failed, or stopped
- **THEN** the delegation Item SHALL reach the matching terminal outcome with unfinished agents marked accordingly, and the Host Turn SHALL complete only after the Root continuation for that settlement finishes

#### Scenario: User cancels during a Workflow

- **WHEN** the user cancels while the Root Segment is active
- **THEN** the native interrupt SHALL stop the Workflow and its Item SHALL settle as cancelled
- **WHEN** the user cancels a Host Turn held for a launched Workflow
- **THEN** Claude Adapter SHALL stop the Workflow task through the native task stop control and report its unfinished agents as interrupted

#### Scenario: Workflow approval is requested

- **WHEN** Claude Code requests permission to run a Workflow
- **THEN** the Approval SHALL show the native display name and the workflow description Claude Code provides, without the script
