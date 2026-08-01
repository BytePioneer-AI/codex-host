## 1. Public Adapter contract

- [x] 1.1 Add honest `history.forkAcrossCwd` capability to Shared Contracts, HarnessAdapter implementations, Fake Adapter, and schema/contract tests
- [x] 1.2 Define `ForkSessionInput.cwd` as the derived target cwd and test source-only versus caller-selected capability behavior

## 2. Pi cross-cwd Native Fork

- [x] 2.1 Add mutually exclusive Pi transport `sessionFile` and `forkSessionFile` startup options with structured `--session` / `--fork` argv tests
- [x] 2.2 Change PiAdapter Fork to start a distinct native target-cwd Session through `--fork`, use it directly for tail Fork, and apply RPC Fork only for a non-tail cutoff
- [x] 2.3 Add PiAdapter tests for target-cwd propagation, distinct startup/final identity, exact tail/non-tail Snapshot cutoff, failure cleanup, and source isolation

## 3. External Host routing

- [x] 3.1 Accept an absolute external Fork target cwd only when cross-cwd capability is available, validate supplied workspace roots, and persist/project the derived cwd
- [x] 3.2 Preserve the derived target cwd through bounded post-Fork rollback while retaining source Checkpoint lineage and Host identity
- [x] 3.3 Add Host tests for Desktop-shaped Worktree Fork, exact rollback, source/derived independent continuation, unsafe override rejection, restart, and official passthrough

## 4. Baseline documentation

- [x] 4.1 Update PRD, architecture, HarnessAdapter design, and development checklist to distinguish Desktop-provisioned Worktree consumption from codexhost-owned Worktree lifecycle

## 5. Verification

- [x] 5.1 Run focused Shared Contracts, HarnessAdapter, PiAdapter, Pi transport, Protocol Core, Mapping Store, and Host tests
- [x] 5.2 Run `npm run check`, `npm run build`, strict OpenSpec validation, and `git diff --check`
- [x] 5.3 Run an isolated offline Pi control-plane Gate proving native `--fork` creates a distinct target-cwd Session without modifying the source
- [ ] 5.4 Run controlled macOS and Windows Desktop/Pi `Use a new worktree` tail/non-tail Gates, verify target-only file execution and source isolation, and record only sanitized evidence
