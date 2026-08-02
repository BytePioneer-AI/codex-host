## ADDED Requirements

### Requirement: Pi maps only explicit native thinking into live Reasoning

PiAdapter SHALL map non-empty thinking text explicitly emitted by Pi for an accepted Turn into ordered Host Reasoning Items. PiAdapter SHALL keep Pi event names and message blocks private and SHALL NOT derive Reasoning from Thinking level, Model `reasoning` metadata, Usage, Tool activity, or elapsed time.

#### Scenario: Pi streams thinking for one Assistant message

- **WHEN** Pi emits thinking boundaries and one or more `thinking_delta` values for an Assistant message
- **THEN** PiAdapter SHALL expose one Reasoning Item for that message with the deltas appended in order
- **AND** the Item SHALL complete before the owning Turn terminal

#### Scenario: Pi complete message extends streamed thinking

- **WHEN** Pi's complete Assistant message contains the streamed thinking prefix plus a suffix
- **THEN** PiAdapter SHALL append only the missing suffix before completing the Reasoning Item
- **AND** no streamed text SHALL appear twice

#### Scenario: Pi emits only complete thinking

- **WHEN** no thinking delta is available but a complete Assistant message contains non-empty thinking text
- **THEN** PiAdapter SHALL publish that text once through a complete Reasoning Item

#### Scenario: Pi reports reasoning capability without content

- **WHEN** the selected Pi Model reports `reasoning=true`, a non-off Thinking level, or reasoning Usage but the Turn emits no thinking text
- **THEN** PiAdapter SHALL emit no Reasoning Item

### Requirement: Pi history restores explicit thinking from the active branch

PiAdapter SHALL map non-empty persisted Assistant `thinking` blocks on the active Pi Entry branch into deterministic Reasoning Item snapshots without changing existing Native Turn, Checkpoint, Agent Message, Tool, or File Change identities.

#### Scenario: Active Pi history contains thinking

- **WHEN** an active-branch Assistant Entry contains thinking followed by displayable Assistant text
- **THEN** `readSnapshot()` SHALL return deterministic Reasoning and Agent Message Items in the supported native order
- **AND** repeated Snapshot reads SHALL return the same Reasoning Item IDs and text

#### Scenario: Inactive Pi branch contains thinking

- **WHEN** `get_entries` contains thinking only on an Entry outside the active leaf ancestry
- **THEN** PiAdapter SHALL omit that Reasoning from the current Snapshot

#### Scenario: Pi history contains no visible thinking

- **WHEN** active history contains no non-empty Assistant thinking block
- **THEN** the Snapshot SHALL contain no Reasoning Item derived from Model metadata, Thinking-level changes, or token statistics
