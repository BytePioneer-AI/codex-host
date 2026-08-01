## Context

`DraftAgentController` currently initializes every logical Composer as `codex / draft`. Renderer submission handling already resolves the mounted Composer's final Agent for click, Enter, and form submission, while opening an existing conversation uses a separate ownership-inspection path. The requested behavior is process-local and must not weaken the existing Composer identity, prewarm, ownership restoration, or fail-closed rules.

## Goals / Non-Goals

**Goals:**

- Remember the Agent from the most recently submitted Composer in one Renderer process.
- Initialize only a new opaque `default` Composer with that Agent.
- Keep passive Thread opening and unsubmitted draft switching from changing the remembered Agent.
- Preserve cold-start Codex behavior and reset per-Composer Pi Model state.

**Non-Goals:**

- Persistence across Desktop restart or synchronization across Renderer processes.
- Changes to Host Runtime, Mapping Store, Harness registration, or transport routing.
- Inheriting the prior Thread's Model or changing immutable Thread ownership.

## Decisions

### 1. Keep the remembered Agent inside DraftAgentController

The controller owns one `lastSubmittedAgent` value initialized to Codex. The existing submission notification path records the mounted Composer's current Agent on every real submission, including later Turns on an already locked Thread.

Recording at submission rather than Agent selection or Thread mount matches user work intent. A process-level browser global is unnecessary and would make lifecycle and tests less explicit.

### 2. Apply the remembered Agent only to a new default target

`mount()` initializes an unseen Composer with the remembered Agent only when its opaque Model target is `default`. An unseen `conversation` target continues to initialize conservatively as Codex until fixed Host ownership inspection restores and locks its actual Agent. This avoids transiently applying another Thread's Agent state while ownership is unresolved.

The remembered value contains only the Agent enum. Pi Model Ref, asynchronous request generations, and control state remain scoped to the new Composer and start empty.

### 3. Preserve existing submission and prewarm mechanics

The new default flows through the existing Adapter application, Pi catalog loading, submission blocking, and final lock paths. Agent switching still clears stale prewarm state. No new asynchronous initialization or request hook is introduced.

## Risks / Trade-offs

- [Desktop restart resets the default to Codex] -> This is the explicit process-local scope; persistence can be proposed separately.
- [An unseen conversation briefly uses the remembered Agent] -> Initialize remembered state only for `default` targets; conversation ownership remains on the current inspection path.
- [Duplicate DOM submission signals] -> Re-recording the same Composer Agent is idempotent.
- [Remembered external Agent becomes unavailable] -> The existing Adapter availability and fail-closed submission rules remain authoritative.
