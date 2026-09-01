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

## THIRD REWORK

- Replaced the unjournaled quarantine flow with a strict, random-id transaction journal. Journal files are established with exclusive create and fsync before any rename; completion is an exclusive hard link to the exact journal inode, so retry state is never cleared by pathname deletion.
- Lifecycle entry points recover journals before install, status, or uninstall. Faults after journal creation, quarantine rename, and quarantine hashing resume the same transaction. A managed uninstall remains recoverable as a retained quarantine; active `SKILL.md` is absent, and later installs do not cause recovery to touch a new occupant.
- Conflict recovery uses a no-clobber hard link. If the destination is occupied, destination, quarantine, and journal are all retained and the operation fails closed. No verified quarantine is physically removed by pathname.
- Canonical home validation now compares native `realpath` of the raw input with canonical resolution of its lexical absolute form, rejecting `safe/link/..`; destinations are derived only from the canonical home. Commit seams revalidate canonical ancestry immediately before and after create/link/rename operations.
- Missing installs use `open(..., "wx")`; managed legacy updates use the same journal/quarantine protocol. A forged journal cannot inject a digest: only the current digest and the genuine historical `15eb6351...` digest are trusted.
- Added a source-private filesystem/hook seam (not exported from the package index) for uid, fault, race, hash-swap, and ancestor-swap regressions.
- Exported the existing source-level `prepareDelegationRuntime` seam and ran real preparation under a temporary `HOME`; `createHost` completed, `.agents`/`.claude` remained absent, and the control endpoint was closed afterward.

### THIRD REWORK verification

1. `npm run build:typescript` — passed.
2. `npx vitest run packages/host-runtime/test/delegation-skill.test.ts packages/host-runtime/test/run-host-runtime.test.ts --config tests/vitest.config.js` — 24 passed.
3. `npx eslint packages/host-runtime/src/delegation-skill.ts packages/host-runtime/src/run-host-runtime.ts packages/host-runtime/test/delegation-skill.test.ts packages/host-runtime/test/run-host-runtime.test.ts` — passed.
4. `npx prettier --check packages/host-runtime/src/delegation-skill.ts packages/host-runtime/src/run-host-runtime.ts packages/host-runtime/test/delegation-skill.test.ts packages/host-runtime/test/run-host-runtime.test.ts` — passed.
5. `git diff --check` — passed.

## STATUS FIX

- `skill status` / `inspectDelegationSkills` is strictly read-only again: it classifies only each active destination and never scans or recovers transaction journals.
- Added pending-uninstall regressions for faults after journal creation, quarantine rename, and quarantine hashing. Status reports the active entry as `current` or `missing` and leaves destination, quarantine, journal, completion link, directory entries, contents, inode, mode, size, and mtime unchanged; no mutation hook runs.
- Recovery remains limited to install and uninstall entry points. Strict malformed/forged journal checks now exercise those mutating entry points rather than status.

### STATUS FIX verification

1. `npm run build:typescript` — passed.
2. `npx vitest run packages/host-runtime/test/delegation-skill.test.ts packages/host-runtime/test/delegation-cli.test.ts --config tests/vitest.config.js` — 52 passed.
