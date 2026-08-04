## MODIFIED Requirements

### Requirement: Claude Native history maps deterministically

`readSnapshot()` SHALL read only the identified Native Session through the official Claude SDK history API and SHALL deterministically map each human User message and its following supported Assistant text and explicit visible thinking into one Host Turn. The caller-assigned User UUID SHALL remain the Native Turn identity. Claude Tool-result User messages, synthetic or metadata User records, local-command output or caveat records, and native Model-selection command envelopes SHALL NOT become human Host Turns. Other genuine human slash-command prompts SHALL remain eligible for projection. codexhost SHALL NOT persist a second Transcript.

#### Scenario: Completed Claude history is read repeatedly
- **WHEN** a Claude Session containing completed text Turns and visible Assistant thinking is read more than once
- **THEN** every read SHALL return the same ordered Native Turn identities, inputs, Agent Message and Reasoning identities, supported text, and outcomes
- **AND** the read SHALL NOT start a Claude Query or emit live Session outputs

#### Scenario: Native Tool messages occur within a Turn
- **WHEN** Assistant Tool use and User Tool-result messages occur between a human User message and the terminal Assistant message
- **THEN** those messages SHALL remain within the same historical Turn
- **AND** only currently supported Assistant text and explicit visible thinking SHALL be projected as historical Items

#### Scenario: Native history contains model-selection records
- **WHEN** Claude history contains a `/model` command envelope, `<local-command-stdout>` result, or `<local-command-caveat>` adjacent to human conversation
- **THEN** those native control records SHALL NOT create Host Turns
- **AND** the surrounding human Turns SHALL retain their Native Turn identities and order

#### Scenario: Native history contains another human slash command
- **WHEN** a human User record contains a supported slash-command envelope other than the native Model-selection control record
- **THEN** the command prompt SHALL remain eligible to create a Host Turn
- **AND** transcript tags SHALL NOT cause unrelated human text to be discarded

#### Scenario: Native history contains redacted or unsupported blocks

- **WHEN** an Assistant message contains redacted thinking, signatures, encrypted data, Tool blocks, or another unsupported non-text block
- **THEN** the history mapper SHALL omit that content from Reasoning
- **AND** it SHALL NOT expose the native block through another Host Item

#### Scenario: Native history omits complete Result evidence
- **WHEN** official history contains Assistant messages but not the complete Result fields required by Claude live terminal classification
- **THEN** the historical Turn outcome SHALL remain `unknown`
- **AND** the Adapter SHALL NOT infer success from Assistant `stop_reason` or Reasoning alone

#### Scenario: Native history identity is inconsistent
- **WHEN** history contains a mismatched Session identity, duplicate message identity, or malformed conversation message
- **THEN** `readSnapshot()` SHALL fail with a normalized protocol error
- **AND** no partial Snapshot SHALL be returned
