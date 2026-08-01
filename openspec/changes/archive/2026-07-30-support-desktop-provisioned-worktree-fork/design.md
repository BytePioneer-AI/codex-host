## Context

The active history-Fork implementation treats `ForkSessionInput.cwd` as equal to the source Thread cwd. Supported Codex Desktop `26.721.41059` uses the same `fork-conversation-from-turn` function for both message actions, but its Worktree workflow first provisions a workspace root and then calls `thread/fork` with that root as `cwd` and as the first runtime workspace root. The current Host rejects that request before Adapter execution.

Worktree provisioning and Native history derivation are separate operations. Codex Desktop owns Git creation, setup status, failure UI, and owner metadata. Codex app-server accepts a target cwd in `thread/fork`. Pi 0.82.1 does not create a Git Worktree, but its native CLI `--fork <source-session>` calls `SessionManager.forkFrom(sourcePath, targetCwd)`, creates a distinct Session with a target-cwd header, and copies source entries. Pi RPC `fork` and `clone` only branch the already opened Session and cannot change cwd.

The current PiAdapter starts Fork with `--session <source-session>` and then issues RPC `fork` or `clone`. Pi resolves `--session` runtime cwd from the source Session header, so merely spawning that command from the Worktree directory would silently keep source-cwd execution. The Adapter must select the native cross-project startup primitive.

This change depends on active change `implement-external-thread-history-fork-slice`, whose real Windows and official Codex regression Gates remain outstanding. The current PRD and architecture explicitly require same-cwd Fork and exclude automatic Worktree creation, so this change updates them to distinguish accepting a Desktop-provisioned target from codexhost-owned Worktree lifecycle.

## Goals / Non-Goals

**Goals:**

- Let the native Desktop `Use a new worktree` action Fork a Pi-owned Thread through the same exact history and rollback flow as `Use this workspace`.
- Keep Worktree and Git lifecycle outside HarnessAdapter and codexhost.
- Make cross-cwd Fork an explicit, honestly reported Adapter capability.
- Preserve source Harness ownership, source Native Session contents, exact Checkpoint cutoff, derived Host identity, and target-cwd continuation across restart.
- Keep official Codex request frames transparent.

**Non-Goals:**

- Creating, deleting, naming, repairing, or garbage-collecting Git Worktrees.
- Rolling back, copying, snapshotting, or patching project files during Fork.
- Inferring a Worktree from Git metadata or accepting a rollout `path` as an external Native Session locator.
- Implementing Claude Code history/Fork or claiming every registered Harness supports caller-selected cwd.
- Adding a Worktree-specific Adapter method, Host command, Renderer hook, or Mapping Store format.

## Decisions

### 1. Adapter abstracts target-cwd Native Fork, not Worktree

`HarnessAdapter.open(fork)` remains the only interface:

```ts
{
  kind: "fork";
  sourceRef: NativeSessionRef;
  checkpoint: NativeCheckpointRef;
  cwd: string; // target execution cwd
}
```

The Adapter returns only after it has a distinct final Native Session whose Snapshot ends exactly at the Checkpoint and whose tools, project resources, and future Turns use the requested cwd. Harness-specific temporary Sessions remain implementation details.

Alternative: add `createWorktree()` or `forkToWorktree()`. Rejected because Git lifecycle belongs to Desktop and would couple every Harness to one workspace mechanism.

Alternative: Host copies visible Transcript into a create Session. Rejected because Native Session is the only complete history source and visible projection omits hidden Harness state.

### 2. Cross-cwd support is reported separately from exact Fork

`HarnessSessionCapabilities.history` and Harness inspection add `forkAcrossCwd`. `fork=true` continues to mean exact same-cwd Native Fork. `forkAcrossCwd=true` means the Adapter can satisfy `open(fork)` when the target differs from source cwd. An Adapter with `forkAcrossCwd=false` returns `unsupported` before creating a replacement Session.

Pi reports both values true. Claude Code remains false for both in production until its Snapshot and stable Checkpoint mapper is implemented and gated.

Alternative: redefine `fork=true` to imply any cwd. Rejected because it would make existing and future same-cwd-only Adapters dishonest.

### 3. Host validates ownership separately from location intent

For an external Fork, Host computes `targetCwd = fork.cwd ?? source.cwd`. It continues to reject a non-empty rollout `path`, Model carrier change, Model Provider change, active source, invalid boundary, missing Checkpoint, and unsupported capability. A changed target must be an absolute path; supplied runtime workspace roots must also be absolute and include the target. Host does not inspect Git metadata or create the directory.

The provisional and final derived records persist `targetCwd`. Mapping Store V1 already stores cwd per Thread, so no migration is required. The Fork response returns the committed derived cwd and preserves the Desktop-provided runtime roots.

Alternative: accept every cwd string and let spawn fail. Rejected because relative locations are ambiguous across Host and child processes and current Codex workspace-root protocol uses absolute paths.

### 4. Post-Fork rollback keeps source history and derived location distinct

The supported Desktop first creates an unbounded tail Fork and then sends `thread/rollback`. Lineage continues to be proven by source Host Thread, source boundary, ordered prefix length, Harness, and Native identity; source/derived cwd equality is removed from that proof.

The final rollback Session is opened from the source NativeSessionRef and retained source Checkpoint with `cwd: derived.cwd`. Mapping replacement keeps the same derived Host Thread ID, retained Host Turn IDs, target cwd, and rebuilt final Native refs.

### 5. Pi uses native CLI cross-project Fork before exact slicing

Pi transport gains mutually exclusive `sessionFile` and `forkSessionFile` startup options. The latter produces structured argv `--fork <source-file>` and never evaluates a shell string.

PiAdapter Fork flow is:

```text
validate source Ref and Checkpoint
spawn pi --mode rpc --fork <source-file> in target cwd
verify startup Session identity differs from source
read copied active history and resolve source Checkpoint ID
  tail     -> startup Session is already the final exact clone
  non-tail -> RPC fork(nextUserEntryId), verify another distinct identity
read final Snapshot and prove exact cutoff
return the target-cwd HarnessSession
```

For a non-tail boundary, the startup full clone becomes an unmapped Native Session after RPC Fork. It is retained like the existing bounded rollback temporary Session; no Harness-specific deletion protocol is introduced.

Alternative: keep `--session` and rely on child process cwd. Rejected because Pi rebuilds runtime services from the source Session header cwd.

Alternative: parse or rewrite the source Session header. Rejected because it mutates or duplicates Harness-owned persistence outside native APIs.

### 6. Verification exercises the public seam and real native argv

Hermetic tests verify capability parsing, target-cwd propagation, source/derived cwd lineage, rollback replacement, official passthrough, Pi argv selection, tail/non-tail identity, and target-cwd continuation. A local isolated Pi control-plane Gate uses synthetic Session data, an isolated Session directory, offline startup, and no model Turn to confirm `--fork` writes a distinct target-cwd Session. The final Desktop Gate creates a disposable Git Worktree, Forks tail and non-tail messages, executes a cwd/file probe only in the derived Thread, and checks source isolation.

## Risks / Trade-offs

- [Pi `--fork` is absent or behaves differently in another installed build] -> Use structured native argv, verify distinct identity and exact Snapshot, and return an explicit Harness failure without a version whitelist.
- [Target Worktree is deleted before resume] -> Preserve the mapped ownership and return an explicit native/session error; do not fall through to Codex or recreate the Worktree.
- [Non-tail Pi Fork leaves an intermediate full clone] -> Close the active runtime after final native Fork and retain the native file; deletion remains outside the Adapter contract.
- [Runtime workspace roots and cwd disagree] -> Reject changed-cwd requests whose supplied roots are not absolute or do not contain the target.
- [An Adapter reports cross-cwd support without binding tools to the target] -> Contract tests and real Gates must execute a target-only cwd/file probe before enabling the capability.
- [This overlaps an unarchived history-Fork change] -> Keep a separate OpenSpec change and commit, preserve the current rollback commit, and do not mark either change's platform Gates complete without evidence.

## Migration Plan

1. Add capability and Adapter interface semantics with Fake and schema tests.
2. Add Pi native `--fork` transport startup and exact tail/non-tail Adapter behavior.
3. Allow and persist target cwd in Host direct Fork and bounded rollback.
4. Update product, architecture, Adapter, and development status documents.
5. Run focused tests, `npm run check`, build, strict OpenSpec validation, isolated Pi control-plane Gate, then real Desktop Worktree Gate.
6. Rollback restores same-cwd Host validation and Pi `--session` plus RPC Fork. Existing cross-cwd derived records remain valid Native mappings but resume fails explicitly if their cwd is unavailable; no Native Session or Worktree is deleted.

## Open Questions

- Does the target Windows Desktop build pass the Worktree root as the first `runtimeWorkspaceRoots` entry exactly like supported macOS Desktop `26.721.41059`?
- Does Pi on Windows accept an absolute source Session path through `--fork` when launched by a `.cmd` wrapper with verbatim argument handling?
- What Desktop behavior is shown after its owned Worktree is deleted while a mapped external Thread remains in history?
