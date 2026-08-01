## Why

Codex Desktop exposes `Use a new worktree` for the same message-level Fork action that external Pi Threads already handle, but it supplies a Desktop-created target `cwd` and the Host currently rejects every cwd change. Pi 0.82.1 can natively fork a source Session into a caller-selected cwd through `pi --fork` / `SessionManager.forkFrom`, so codexhost can support the Desktop option without creating or managing Git Worktrees and without replaying Transcript content.

## What Changes

- Define caller-selected target cwd as an optional structural capability of exact HarnessAdapter Fork while keeping same-cwd Fork available independently.
- Accept a Desktop-provisioned target cwd for an external Fork, persist it as the derived Thread cwd, and preserve the existing source Harness, Model Provider, Native Session ownership, exact Checkpoint, and Host identity invariants.
- Keep the supported Desktop's `thread/fork -> thread/rollback` composition exact when the derived Thread cwd differs from its source by re-Forking the retained source Checkpoint into the derived target cwd.
- Implement Pi cross-cwd Fork with the native CLI `--fork <source-session>` path, then perform a native RPC history Fork only when a non-tail boundary still needs slicing.
- Continue rejecting non-empty rollout `path`, Harness or transport Model ownership changes, malformed workspace roots, and unsupported Adapter capability.
- Update product and architecture baselines to distinguish Desktop-provisioned Worktree consumption from Worktree creation, deletion, Git branch management, or project file rollback by codexhost.
- Add hermetic Host, Adapter, transport, persistence, and protocol tests plus a controlled real Pi/Worktree Gate.

## Capabilities

### New Capabilities

- `harness-adapter-cross-cwd-fork-session`: Exact Native Session Fork into a caller-selected target cwd, honest capability reporting, source isolation, and target-cwd execution semantics.
- `external-thread-worktree-fork-routing`: Ownership-safe routing and persistence for Desktop-provisioned Worktree Fork, including bounded post-Fork rollback in the derived cwd.

### Modified Capabilities

- `pi-model-routed-vertical-slice`: Pi Fork startup gains native cross-project Session Fork and exact target-cwd continuation without Pi creating the Worktree.

## Impact

- Affects `shared-contracts`, `harness-adapter`, `adapters/pi`, `host-runtime`, and their tests; Mapping Store records already persist each Thread's cwd and require no format migration.
- Updates `docs/产品需求文档.md`, `docs/技术架构设计文档.md`, `docs/HarnessAdapter技术设计文档.md`, and `docs/开发步骤清单.md` so product, architecture, implementation, and validation agree.
- Depends on the implementation in active change `implement-external-thread-history-fork-slice`; it does not complete or replace that change's outstanding Windows and official Codex regression Gates.
- Adds no Git dependency, Worktree manager, Renderer hook, Transcript persistence, Native Session file mutation, or Harness-specific Host command.
