## ADDED Requirements

### Requirement: Renderer can select DeepSeek Harness for a new Thread
A compatible Renderer SHALL expose DeepSeek Harness as an external Agent and inject its dedicated transport Model when selected.

#### Scenario: User selects DeepSeek Harness
- **WHEN** DeepSeek Harness inspection is available and the user selects it for a new Thread
- **THEN** the Renderer SHALL submit `codexhost/deepseek-harness-native` with the selected DeepSeek Model configuration

#### Scenario: DeepSeek Harness is unavailable
- **WHEN** inspection reports the DeepSeek runtime unavailable
- **THEN** the Agent option SHALL remain unavailable
- **AND** existing Codex, Pi, and Claude Code choices SHALL remain usable

### Requirement: Existing Thread ownership restores DeepSeek Agent state
The Renderer SHALL recognize `deepseek-harness` ownership records and display the corresponding Agent for an existing process-local Thread.

#### Scenario: DeepSeek-owned Thread is selected
- **WHEN** Renderer reads ownership identifying `deepseek-harness`
- **THEN** it SHALL restore the DeepSeek Agent label and transport selection without treating it as Pi or Claude Code
