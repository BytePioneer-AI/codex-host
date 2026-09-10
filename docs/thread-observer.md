# Thread observer

`thread observe` is a read-only CLI client loop over the existing Runtime `wait-many` API. It invokes no Model, starts no Turn, and makes no scheduling or business-state decisions. Runtime requests still wait at most 60 seconds; the observer renews them internally without returning each idle checkpoint to its caller.

## Invocation

Use the CLI path supplied by the current Host. POSIX example (use the equivalent environment-variable invocation on other shells):

```sh
"$CODEXHOST_CLI_PATH" thread observe --targets-file /absolute/targets.json --timeout-ms 300000
```

Targets are a nonempty JSON array; IDs must be unique:

```json
[
  {"threadId": "child-a", "expectedTurnId": "turn-a"},
  {"threadId": "child-b", "afterRevision": "opaque-revision-from-status"}
]
```

A target can also contain `reviewAt`, an absolute ISO timestamp with a timezone. Choose that timestamp from the current task's next useful review time. The earliest target deadline bounds each internal wait. The overall timeout defaults to five minutes and is capped at one hour; zero performs one immediate Runtime snapshot. Neither deadline cancels a child.

The command writes **one JSON result** when:

- a target completes, fails, or is interrupted;
- a projected Host Interaction needs input;
- a target changes Turn, a cursor requires resync, or a target reports an error;
- a target's review deadline or the overall timeout expires;
- SIGINT/SIGTERM stops the observer (exit 130/143).

Ordinary output revisions update the internal cursor and do not return control. The result contains `reason`, `events`, compact `statuses`, resumable `targets`, `elapsedMs`, `requests`, and `suppressedChanges`. It contains no historical messages or tool bodies. On resumption, consume the returned cursors, remove handled terminal targets, and advance consumed review deadlines. Use `thread read` or `thread evidence` separately for the changed target's details.

`expectedTurnId` prevents silently observing replacement work. Without it, the observer binds the first observed Turn. Invalid or restarted-Runtime cursors return `resync`; the caller decides whether the new state still belongs to its attempt. Transport failures get at most two internal retries; authentication and protocol failures return immediately. The observer keeps no independent task database and never mutates the targets file.

`pendingInteractions` is derived from the live external Turn projector, not guessed from text. Official Threads, unloaded projections, and older Runtimes may not expose this field; the result lists them in `inputVisibilityUnavailable`. Bounded review remains necessary for targets without this capability. The observer never answers or approves an interaction.

## Outer-tool boundary

Keeping a CLI process alive does **not** by itself prove the coordinator Model stayed idle. The calling tool must await that same process without returning to model inference on every transport timeout. If a tool yields a process/session handle, retain it and resume that process; do not start another observer. A programmatic tool wrapper can await internal process polls without model inference, provided its own invocation is allowed to remain pending.

For a caller with programmatic tool orchestration, put **all** process-handle polling inside one awaited invocation, and give that invocation a yield budget longer than the observer's total timeout plus transport overhead. The following is the pattern tested in a Codex session exposing `functions.exec` (POSIX command; tool names and budgets must match the actual caller):

```javascript
// @exec: {"yield_time_ms": 120000}
let result = await tools.exec_command({
  cmd: '"$CODEXHOST_CLI_PATH" thread observe --targets-file /absolute/targets.json --timeout-ms 90000',
  yield_time_ms: 1000,
});
let output = result.output;
while (result.session_id) {
  result = await tools.write_stdin({
    session_id: result.session_id,
    chars: "",
    yield_time_ms: 10000,
  });
  output += result.output;
}
text({ exitCode: result.exit_code, output });
```

The bounded probe was observed through one such outer invocation for approximately 75 seconds, with no intermediate model return. This establishes that invocation path, not unlimited waiting or a guarantee for every tool. Do not configure a five-minute observer inside a two-minute outer wait and claim the same result.

If the outer tool itself has a hard short yield/deadline, repeated resumptions can still invoke the Model. Report this limitation rather than claiming zero wakeups. A detached process or result file cannot wake a suspended parent; no callback/daemon is added here. Stop observation independently from `thread cancel` and `thread release`.

## Verification

Focused tests use `tests/vitest.config.js`: `thread-observer`, `thread-observer-runtime`, `thread-change-hub`, `harness-delegation-coordinator`, `delegation-cli`, and `delegation-skill` tests, plus the projector interaction test.

After building the owning package, the bounded wall-clock probe runs the real Runtime HTTP server and a real observer CLI process against controlled fixture Threads:

```sh
node tools/delegation/observe-probe.mjs --duration-ms 66000
```

It crosses an actual 60-second idle wait, introduces ordinary progress, completes a target, and checks that the CLI emitted one result. It also sends SIGTERM to another observer and confirms its child remains running. Fixtures call no Model. The probe reports Runtime/CLI evidence only: actual outer-tool wakeups must be checked in the invocation that runs it, separately from fixture success. It creates a temporary isolated Runtime, closes it, and removes only its own temporary files. It does not restart or install the user's Host.
