## MODIFIED Requirements

### Requirement: Composer Agent freezes at submission

The Renderer Extension SHALL keep Agent state isolated by logical Composer, SHALL keep the selected Agent mutable while the user edits a draft, SHALL synchronously freeze the final Agent when that draft is submitted, and SHALL remember the Agent of the most recently submitted Composer for later new-Thread drafts in the same Renderer process.

#### Scenario: User switches after editing

- **WHEN** a user types, pastes, composes with an IME, deletes content, inserts an attachment, or adds a line break before submission
- **THEN** the Composer remains in the draft phase and the user can still select Codex or Pi

#### Scenario: Agent switch invalidates stale prewarm

- **WHEN** a draft Composer selects a different Agent
- **THEN** the Renderer first applies that Agent's optimistic Model state and then calls the official `clear-prewarmed-threads-for-host` operation for the uniquely owned local host

#### Scenario: Submission freezes the final Agent

- **WHEN** the user clicks Send, presses Enter without Shift or active IME composition, or submits the Composer form
- **THEN** the Renderer synchronously reapplies the final Agent, locks the Composer, records that Agent as the most recently submitted Agent, and records one deduplicated submission before Desktop creates or consumes the submitted Thread

#### Scenario: First creation replaces the Composer DOM

- **WHEN** a draft or locked new-Thread Composer transitions from its opaque `default` Model target to a `conversation` target
- **THEN** the replacement Composer retains the same logical Composer identity, selected Agent, and phase

#### Scenario: User opens a new Thread

- **WHEN** a conversation Composer is replaced by a new default Composer
- **THEN** the new Composer starts in draft phase with the Agent used by the most recently submitted Composer in the same Renderer process
- **AND** it starts as Codex when no Composer has been submitted in that Renderer process

#### Scenario: User only opens an existing Thread

- **WHEN** the user opens or revisits a Thread without submitting a Turn
- **THEN** that Thread's Agent does not replace the most recently submitted Agent used for later new-Thread drafts

#### Scenario: User revisits a submitted Thread

- **WHEN** a submitted conversation Composer is unmounted and an equivalent opaque conversation Model target is mounted again in the same Renderer process
- **THEN** the Renderer restores that logical Composer's identity, final Agent, and locked phase
- **AND** it does not interpret, serialize, or persist the opaque target's Thread identity

#### Scenario: Switch is in flight

- **WHEN** the official prewarm clear has not settled
- **THEN** Agent controls and submission are disabled for that Composer

#### Scenario: Switch fails

- **WHEN** prewarm clearing fails
- **THEN** the Renderer restores the prior Agent; if restoration also fails, the Adapter becomes unsupported and submission fails closed

#### Scenario: User attempts to switch after submission

- **WHEN** a Composer Agent is locked
- **THEN** the Agent controls are disabled and selecting another Agent requires a new Thread

### Requirement: Pi Model state follows the logical Composer lifecycle

The Renderer SHALL keep the selected Pi Model Ref and asynchronous Model-control state scoped to the same logical Composer identity used for Agent routing while allowing Model selection for an existing Pi Thread only through its validated current-process Thread identity.

#### Scenario: Draft replacement retains Model

- **WHEN** a Pi draft or locked new-Thread Composer transitions from its opaque default target to the created conversation target
- **THEN** the replacement retains the selected Pi Model Ref and control state

#### Scenario: Same-process conversation revisit

- **WHEN** an equivalent opaque conversation target is revisited in the same Renderer process
- **THEN** the Renderer restores the final Pi Model Ref without persisting or logging the Thread identity

#### Scenario: New task resets Model

- **WHEN** a conversation target transitions to a new default Composer
- **THEN** the new Composer uses the most recently submitted Agent without inheriting the prior Composer's Pi Model Ref

#### Scenario: Existing Pi Thread selection

- **WHEN** the supported conversation target yields one validated current-process Host Thread ID and the user selects a different Pi Model
- **THEN** Renderer sends the fixed Thread Model-selection request and applies only the confirmed effective Ref returned from Host state observation

#### Scenario: Stale asynchronous result

- **WHEN** an earlier inspection or selection resolves after the logical Composer, Agent, target, or request generation changed
- **THEN** Renderer ignores that result and preserves the newer state
