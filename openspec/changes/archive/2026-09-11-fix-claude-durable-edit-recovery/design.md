## Context

Depends on fix/claude-history-reliability. Upstream 0.6.0 already declares rollback support; the missing behavior is persistence and recovery of an empty result, not capability discovery.

## Decisions

A pending Native Session Ref has locator {pendingSession: 1}. Store versioned metadata under CLAUDE_CONFIG_DIR/codexhost/pending-sessions with owner-only permissions, synced writes and an exclusive creation claim. Missing transcript alone never proves an empty Session. Unclaimed, validated metadata can resume in create mode. Claimed metadata requires actual native history; it cannot silently recreate missing history.

Persist Model, Thinking and Permission Mode before publishing configuration. Pass current settings through optional rollback fields so fixed or lazily created Sessions receive them before startup. Broker accepts these fields; deployments using them need the matching Broker build. Old callers and unextended Adapters remain valid.

Native Fork must retain equivalent ordered content/outcomes/checkpoint availability while assigning independent identity, and must preserve the source. An interrupted human message can serve as a boundary even without assistant output. Delete only the candidate on failed derivation validation.

Track initialization until it settles. Close the transport before waiting on configuration/startup so those RPCs can unblock. A claim may be released only if this wrapper owns it, no input was submitted and shutdown succeeded. Unix SDK spawns own process groups; shutdown checks group absence after TERM/KILL, including a wrapper whose root exited. Background stop receipts require native terminal evidence. Windows uses taskkill with its platform limitations explicitly unverified here.

Real CLI testing reproduced configuration loss after cold resume: lazy native state lacked Model/Thinking, and restoring Permission Mode published defaults. Optional saved Model/Thinking hints now travel on resume as well. Claude applies them before other configuration commands; durable pending metadata takes precedence. Other Adapters retain their native resume behavior.

## Scope and risks

No global native isolation is promised. Other services, independently attached clients and other Harnesses are not terminated. Host transaction admission and commit recovery are handled separately. Adapter Session methods necessarily own startup and configuration state; persistence and process-group logic are separate focused modules to avoid adding those responsibilities to the large existing Session module.

Pending format is additive; older Adapter versions do not understand empty pending identities. Preserve metadata and transcripts when downgrading; use a compatible reader to continue those Threads. This change does not delete source history or roll back worktree files.

## Validation

Adapter regressions cover first/multiple Turn edits, cold resume before and after resend, saved settings, competing claims, spawn failure, close failure, missing metadata/transcripts and delayed flush. Transport tests cover stop acknowledgement versus terminal, output drain and orphaned wrapper children. Broker tests carry optional settings across the socket. Real native CLI gates use disposable workspaces and local deterministic responses; internal authenticated tests are recorded separately.
