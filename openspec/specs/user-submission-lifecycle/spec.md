# user-submission-lifecycle Specification

## Purpose
Keep each user submission independently acknowledged and associated with its actual execution, including operations and extension-handled input that never create a conversation message. Sending state and native execution state remain separately observable.

## Requirements

### Requirement: Each submission has an independent lifecycle

Every identified external Harness submission MUST retain its identity through acceptance, queueing or rejection, execution association and completed, failed or cancelled outcome. Confirmation MUST NOT require a normal user-message echo or clear unrelated submissions when another execution ends. Reconnect and history refresh SHALL reconcile known submissions without resending unknown writes. Submission-in-flight MUST be displayed separately from AI-running state. Official Codex `/compact` is outside this new receipt lifecycle and SHALL retain its existing native acceptance behavior, including acceptance without a Turn ID.

#### Scenario: Temporary operation submitted from chat

- **WHEN** a user submits an operation that creates no conversation
- **THEN** that submission is acknowledged and its operation result reaches a terminal state without leaving a pending chat echo

#### Scenario: Extension handles input locally

- **WHEN** a native extension reports that it consumed input without starting an agent run
- **THEN** its submission settles as an operation without waiting for a nonexistent conversation or fabricating native history

#### Scenario: Queue and steer are correlated

- **WHEN** submissions are queued or steered while another execution is active
- **THEN** each keeps its own confirmation and actual execution identity
- **AND** cancelling or failing one does not silently acknowledge another

#### Scenario: Output or completion precedes acknowledgement

- **WHEN** streaming output or a terminal event arrives before the request response
- **THEN** the same submission is reconciled exactly once with correctly ordered output

#### Scenario: Reconnect and history refresh

- **WHEN** a client reconnects or rereads native history
- **THEN** known execution and submission states are reconciled without duplicate replies, stuck sending indicators or automatic resubmission

#### Scenario: Ordinary attachments

- **WHEN** a user submits ordinary text, images or files
- **THEN** their existing native execution and attachment presentation remain intact
