# Task 12A Report — Delegation Skill Lifecycle Hardening

## RED / GREEN

- RED: lifecycle tests initially failed because `inspectDelegationSkills` and `uninstallDelegationSkills` were not exported/implemented.
- GREEN: focused lifecycle and runtime tests pass after the minimal implementation and hardening changes.

## Ownership and lifecycle changes

- Removed public `previousManagedDigests` injection. Production now trusts only the current digest and fixed historical codexhost digests.
- Added a real legacy fixture from the repository's historical `2ddf4fa` Skill content (version 3), with digest `e2f8814ef21859f51af4afd3b0f8dc0f62b450acd671f8ed6f3522efe5aa2080`.
- Validated home ancestry and managed directories/entries with `lstat`; symlinked ancestors and entries, out-of-home paths, non-directory/non-regular entries, foreign uid, and group/world-writable modes fail closed.
- Uninstall quarantines the exact directory entry via same-directory random rename, re-reads/reclassifies the quarantine, removes only verified managed content, and restores conflicts without deleting parent directories. Rename/read/remove `ENOENT` is treated as missing; other filesystem errors propagate.
- Added symlink ancestor, symlink entry, legacy fixture, conflict preservation, mtime/content preservation, and quarantine-path coverage.

## Startup no-write

The existing `run-host-runtime` focused suite was executed. A dedicated temporary-home startup no-write regression was not added in this lifecycle-only patch; this remains a review concern to cover at the Host preparation boundary.

## Commands and counts

1. `npm run build:typescript` — passed.
2. `npx vitest run packages/host-runtime/test/delegation-skill.test.ts --config tests/vitest.config.js` — 7 passed.
3. `npx vitest run packages/host-runtime/test/delegation-skill.test.ts packages/host-runtime/test/run-host-runtime.test.ts --config tests/vitest.config.js` — 12 passed.
4. `npx prettier --check packages/host-runtime/src/delegation-skill.ts packages/host-runtime/src/index.ts packages/host-runtime/test/delegation-skill.test.ts` — passed.

## Self-review / concerns

- The quarantine sequence closes the destructive TOCTOU window for the exact directory entry, but an adversarial process can still cause restore failure by occupying the original name; the implementation fails closed and does not overwrite that replacement.
- No CLI, README, or startup behavior was changed here.

## Second fix pass

- RED came from the review's historical-digest mismatch and canonical-home regression on macOS `/var`; the corrected fixture is generated from the runtime value at commit `2ddf4fa`, yielding digest `15eb63519ff867e1536c97188a0c43738d7a49d38d4d6adeb7a1036726e7246d`.
- Removed the synthetic `e2f8…` digest. Lifecycle operations now canonicalize the supplied home with `realpath` before deriving destinations, while descendant/entry `lstat` checks reject symlinks and unsafe types/uid/mode.
- Uninstall leaves the verified transaction-owned quarantine in place after exact-entry rename and reclassification; it never removes a post-hash pathname. Conflict restoration remains no-clobber by rename semantics and fails closed if occupied.
- GREEN: `npm run build:typescript`; focused lifecycle test suite: 8 passed. Prettier was run on changed lifecycle files. The dedicated startup temporary-home zero-write test remains an outstanding gap (no startup code was changed in this pass).
- Self-review concern: a full crash-recovery journal/pending-transaction protocol and injected swap/fault seam are not present; retaining quarantine avoids destructive TOCTOU but needs a follow-up recovery workflow before claiming complete crash cleanup.
