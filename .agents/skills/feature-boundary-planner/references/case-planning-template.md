# Case Planning Template

Use this shape when creating a feature-specific decision or coverage-planning doc.

## Feature Summary

| Field                 | Value |
| --------------------- | ----- |
| Change                |       |
| User-visible surfaces |       |
| Existing docs         |       |
| Existing code owners  |       |
| Out of scope          |       |

## Clarification Log

| Round | Question | User answer | Boundary fixed | Follow-up needed |
| ----- | -------- | ----------- | -------------- | ---------------- |
|       |          |             |                | yes/no           |

## Boundary Decisions

| Boundary | Decision | Includes | Excludes / prunes | Source         |
| -------- | -------- | -------- | ----------------- | -------------- |
|          |          |          |                   | user/docs/code |

## Domain Scope

| Domain | Include? | Why it can change behavior | Primary sources |
| ------ | -------- | -------------------------- | --------------- |
|        | yes/no   |                            |                 |

## High-Risk Cross-Products

| Cross-product | Candidate risk | Initial handling         |
| ------------- | -------------- | ------------------------ |
|               |                | enumerate/prune/ask user |

## Concept Map

| Concept | Why it matters | Source |
| ------- | -------------- | ------ |
|         |                |        |

## State Owners

| State / fact | Authority | Mirrors / caches | Evidence |
| ------------ | --------- | ---------------- | -------- |
|              |           |                  |          |

## Dimensions

| Dimension | Values / equivalence classes | Source | Include? | Reason |
| --------- | ---------------------------- | ------ | -------- | ------ |
|           |                              |        | yes/no   |        |

## Candidate Combinations

| Candidate ID | State | Event | Target/surface | Expected guard/effect | Initial status                                  | Notes |
| ------------ | ----- | ----- | -------------- | --------------------- | ----------------------------------------------- | ----- |
|              |       |       |                |                       | accepted/undefined/pruned/ignored/bug-candidate |       |

## Pruning Decisions

| Decision ID | Pruned combinations | Guard/invariant | Product reason | Representative coverage |
| ----------- | ------------------- | --------------- | -------------- | ----------------------- |
|             |                     |                 |                |                         |

## Questions For User

| Question ID | Candidate(s) | Need to decide | Options | Impact |
| ----------- | ------------ | -------------- | ------- | ------ |
|             |              |                |         |        |

## Accepted Cases

| Case ID | Setup | Action | Assertions | Evidence layers                     | E2E status                    |
| ------- | ----- | ------ | ---------- | ----------------------------------- | ----------------------------- |
|         |       |        |            | UI + runtime/protocol/network/files | missing/planned/manual-review |

## Matrix Backfill

| File                       | Change |
| -------------------------- | ------ |
| case catalog               |        |
| coverage matrix            |        |
| decision worksheet/backlog |        |

## E2E Handoff Notes

- Provider fixture:
- File-system fixture:
- Timing strategy:
- Execution environment and available runner:
- Review risks:
