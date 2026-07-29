## Why

Codex Desktop already exposes message-level `thread/fork`, but codexhost currently forwards that request to the official app-server even when the source Thread belongs to an external Harness. Pi has proven native history, resume, exact non-tail Fork, and tail Clone behavior, so codexhost can now make the existing Codex UI action create an exact, independently continuable Pi Thread instead of failing or entering Codex.

## What Changes

- Add the first executable HarnessAdapter history/Fork contract: resume and Fork open modes, deterministic full Snapshot reads, stable Native Turn identity, exact Native Checkpoints, and Fork capability reporting.
- Implement the minimum versioned Mapping Store needed to persist external Thread ownership, Native Session identity, Host Turn identity, Fork Anchors, Desktop timeline metadata, and Fork source metadata without persisting Transcript content.
- Route Codex `thread/fork` by source Thread ownership. Codex-owned requests remain transparent; external requests resolve `lastTurnId` or `beforeTurnId` to a real Checkpoint, create a new Native Session and Host Thread, and return the current Codex `ThreadForkResponse` shape.
- Implement Pi history and exact Fork mapping through Entries/Tree plus native `fork`/`clone`, preserving the source Session and current project files.
- Rebuild every derived Thread from its own Native Session Snapshot and allocate derived Host Turn identities instead of copying source mappings.
- Restore a forked conversation as the source external Agent in the Renderer, keep it locked, and apply only the Host-confirmed effective Pi Model carrier.
- Keep Claude Code development-gated and fail explicitly for production history/Fork until its own Snapshot/Fork mapper implements the shared contract.
- Add hermetic contract, persistence, routing, Pi mapping, Renderer, and current Codex protocol tests, followed by controlled real Codex Desktop/Pi validation.

## Capabilities

### New Capabilities

- `harness-adapter-history-fork-session`: UI-independent Snapshot, Native Turn identity, Checkpoint, resume, and Fork semantics for Harness Sessions.
- `external-thread-mapping-store`: Minimal atomic persistence for external Thread ownership, Native references, Turn mappings, Fork Anchors, and required Desktop timeline metadata.
- `external-thread-fork-routing`: Ownership-aware Codex `thread/fork` decoding, exact boundary resolution, derived Thread projection, error handling, and source isolation.

### Modified Capabilities

- `pi-model-routed-vertical-slice`: Pi-owned Threads gain deterministic history mapping and exact native Fork/Clone into a new Pi Session.
- `registered-harness-routing`: The generic external Thread path gains persisted ownership, Snapshot reads, resume, and capability-driven Fork without Harness-specific Host branches.
- `versioned-renderer-agent-routing`: Fork-created conversation targets recover their Host-confirmed source Agent and Model state as a locked Composer.

## Impact

- Affects `shared-contracts`, `harness-adapter`, `mapping-store`, `protocol-core`, `host-runtime`, `adapters/pi`, `adapters/claude-code`, and `renderer-extension` contracts, implementation, and tests.
- Adds local Mapping Store files under the existing codexhost data directory; no Transcript, Prompt, Tool output, Diff, credentials, or Codex official Thread data is copied into the Store.
- Extends the finite Host-owned protocol surface with a fixed external Thread inspection operation for Renderer restoration; it does not expose a generic request or native RPC escape hatch.
- Preserves official Codex `thread/fork` transparency and does not change Thread Harness ownership, project files, the public Pi MVP Agent list, or Claude Code release status.
