# Impact Brief Template

Use this template for every feature-impact scan. Keep it compact enough to search and compare. Complete sections relevant to the request and explicitly identify unavailable evidence.

## Feature Summary

| Field            | Value                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| Developer intent |                                                                                                    |
| Capability       |                                                                                                    |
| Change layer     | presentation / option-source / draft-default / validation / commit-effect / persistence / recovery |
| Operating mode   | impact-only / planning / implementation-handoff                                                    |
| Primary seeds    |                                                                                                    |
| Out of scope     |                                                                                                    |

## UI Surface Matrix

| User scenario | UI entry | Shared implementation | Display/draft owner | Default/inherit source | Validation/gating | Commit action | Authority/persistence | Mode boundary | Must remain isolated from |
| ------------- | -------- | --------------------- | ------------------- | ---------------------- | ----------------- | ------------- | --------------------- | ------------- | ------------------------- |
|               |          |                       |                     |                        |                   |               |                       |               |                           |

## Shared And Divergent Behavior

| Concern              | Shared across surfaces | Deliberately different | Why it matters for this change |
| -------------------- | ---------------------- | ---------------------- | ------------------------------ |
| UI/component         |                        |                        |                                |
| Option source        |                        |                        |                                |
| Default/inheritance  |                        |                        |                                |
| Validation           |                        |                        |                                |
| Commit effect        |                        |                        |                                |
| Persistence/recovery |                        |                        |                                |

## Feature Relationships

| Rank                                                                         | From | Semantic edge | To  | Condition | Why inspect it | Evidence      |
| ---------------------------------------------------------------------------- | ---- | ------------- | --- | --------- | -------------- | ------------- |
| must-inspect / should-inspect / conditional / invariant-only / evidence-only |      |               |     |           |                | code/doc/test |

## State Owners And Commit Sinks

| State/fact | Draft/display owner | Authoritative owner | Commit command/service | Persistence/cache | Evidence |
| ---------- | ------------------- | ------------------- | ---------------------- | ----------------- | -------- |
|            |                     |                     |                        |                   |          |

## Must-Preserve Invariants

| Invariant | Surfaces/modes | Proof needed | Evidence |
| --------- | -------------- | ------------ | -------- |
|           |                |              |          |

## Source Evidence

| File / symbol | Inspection method                                 | Direct callers / key path | Interpretation |
| ------------- | ------------------------------------------------- | ------------------------- | -------------- |
|               | source / dep:refs / available codegraph / runtime |                           |                |

## Evidence Gaps

| Unresolved behavior | Available evidence | Missing evidence | Next verification |
| ------------------- | ------------------ | ---------------- | ----------------- |
| none or item        |                    |                  |                   |

## Unresolved Questions

| Question     | Candidate answers | Scope difference | Owner                               |
| ------------ | ----------------- | ---------------- | ----------------------------------- |
| none or item |                   |                  | user / product / code investigation |

## Planning Handoff

Complete this only in `planning` or `implementation-handoff` mode.

| Item             | Destination | Status                       |
| ---------------- | ----------- | ---------------------------- |
| Spec update      |             | missing / planned / complete |
| Case catalog     |             | missing / planned / complete |
| Coverage matrix  |             | missing / planned / complete |
| Decision backlog |             | missing / planned / complete |
| E2E handoff      |             | not-needed / planned / ready |
