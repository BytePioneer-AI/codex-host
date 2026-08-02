## MODIFIED Requirements

### Requirement: Claude Native history maps deterministically

`readSnapshot()` SHALL read only the identified Native Session through the official Claude SDK history API and SHALL deterministically map each human User message and its following supported Assistant text and explicit visible thinking into one Host Turn. The caller-assigned User UUID SHALL remain the Native Turn identity. Claude Tool-result User messages SHALL remain within their owning Turn and SHALL NOT become synthetic human inputs. codexhost SHALL NOT persist a second Transcript.

#### Scenario: Completed Claude history is read repeatedly

- **WHEN** a Claude Session containing completed text Turns and visible Assistant thinking is read more than once
- **THEN** every read SHALL return the same ordered Native Turn identities, inputs, Agent Message and Reasoning identities, supported text, and outcomes
- **AND** the read SHALL NOT start a Claude Query or emit live Session outputs

#### Scenario: Native Tool messages occur within a Turn

- **WHEN** Assistant Tool use and User Tool-result messages occur between a human User message and the terminal Assistant message
- **THEN** those messages SHALL remain within the same historical Turn
- **AND** only currently supported Assistant text and explicit visible thinking SHALL be projected as historical Items

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

### Requirement: Claude text streaming has one complete ordered lifecycle

Every accepted Claude text Turn SHALL emit one Turn start, retain the established Agent Message lifecycle, emit zero or more Reasoning Item lifecycles only for explicit visible Claude thinking, emit one terminal for every started Item, and emit one Turn terminal. Unknown native message types and all unsupported non-text content MUST NOT cross the HarnessAdapter seam.

#### Scenario: Partial text and full Assistant agree

- **WHEN** SDK partial events stream a text prefix and the complete Assistant message contains that prefix plus a suffix
- **THEN** the Adapter SHALL append each character exactly once
- **AND** it SHALL append only the missing suffix from the complete message

#### Scenario: Streaming is unavailable

- **WHEN** no partial text event is emitted but a complete Assistant text message arrives
- **THEN** the Adapter SHALL publish that complete text once before the Agent Message Item terminal

#### Scenario: Native text conflicts

- **WHEN** a complete Assistant text cannot be reconciled with text already emitted for the Turn
- **THEN** every started Item and the Turn SHALL fail exactly once
- **AND** the Adapter SHALL NOT replay or replace the visible text silently

#### Scenario: Partial thinking and full Assistant agree

- **WHEN** SDK stream events emit non-empty `thinking_delta` text for one Assistant message and the complete `thinking` blocks contain that prefix plus a suffix
- **THEN** the Adapter SHALL append the visible reasoning characters exactly once through one Reasoning Item for that message
- **AND** it SHALL append only the missing suffix before Item completion

#### Scenario: Thinking streaming is unavailable

- **WHEN** no partial thinking event is emitted but a complete Assistant message contains non-empty visible thinking text
- **THEN** the Adapter SHALL publish that text once through a complete Reasoning Item

#### Scenario: One Turn contains multiple Assistant messages

- **WHEN** a Claude Tool loop or retry produces visible thinking in more than one native Assistant message
- **THEN** the Adapter SHALL keep those messages as ordered distinct Reasoning Item lifecycles
- **AND** complete-message reconciliation for one message SHALL NOT compare against or replay another message's text

#### Scenario: Native thinking conflicts

- **WHEN** complete visible thinking for one Assistant message cannot be reconciled with the thinking already emitted for that message
- **THEN** every started Item and the Turn SHALL fail exactly once
- **AND** the Adapter SHALL NOT silently replace or duplicate visible Reasoning

#### Scenario: Claude emits unsupported thinking forms

- **WHEN** Claude emits redacted thinking, signatures, encrypted content, empty thinking boundaries, or an unknown non-text block
- **THEN** the Adapter SHALL emit no Reasoning text for that content
- **AND** the existing Turn lifecycle and unknown-message tolerance SHALL remain unchanged
