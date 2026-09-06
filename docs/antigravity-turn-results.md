# Antigravity responses followed by ERROR

The reported native conversation contained an initial `Permission denied on
resource project test` error followed by two completed planner responses, with
no new error steps. Host history nevertheless recorded generic `ERROR` results
for both later Turns. This is consistent with a historical cascade error being
included in the CLI's result status.

The Adapter checks the native `GetCascadeTrajectory` response only for a generic
`ERROR` after a completed streamed agent response. It projects success only when:

- The cascade is idle and its ID matches the result.
- The native user-input count matches the result's Turn count.
- An error step exists before the latest user input.
- Every step since that input is done, without an error step or error details.
- The last native step is a planner response at the same index as the completed
  response observed in this invocation's stream.
- There is no explicit result error, stderr diagnostic, permission denial, or
  cancellation.

If native evidence is unavailable or inconsistent, the original failure remains.
Receiving response text alone never establishes success. The Adapter does not
alter the native conversation or remove its earlier error.

Validation uses reconstructed trajectory fixtures and a fake CLI to cover both
the successful reconciliation and unavailable native evidence. A live replay
through the built Host is still needed to establish Desktop acceptance; the
original conversation was inspected read-only and was not replayed or modified.
