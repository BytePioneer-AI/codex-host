# Task 11 report

## Outcome

- Fixed final-review Important #2: Claude Code and Grok create now enforce exact delegated policy/native-mode matrices before transport creation.
- Fixed Important #3: OMP ordinary create keeps explicit `write`/`yolo`; only delegated approval-required and unattended policies constrain the native mode.
- Fixed Important #5: execution policy is carried by resume/fork/rollback inputs and resolved from persisted Delegation lineage for the complete external Thread lifetime.

## RED

- Claude/Grok/OMP create matrix: 14 targeted failures before the Task 11 A/B implementation.
- Shared recovery contract/runtime: 7 targeted failures covering recovery schemas, persisted policy lookup, and resume propagation.
- Six-adapter restart matrix: 9 targeted failures covering Pi, OMP, OpenCode, Claude Code, Grok, and DeepSeek Harness.
- External fork/last-Turn rollback: 1 targeted failure because both adapter opens omitted the persisted policy.
- Incomplete fork lineage: 1 targeted failure because missing source history silently fell back to default policy.

## GREEN

- Six adapters plus shared/broker/runtime/app-server focused Gate: 11 files, 433 tests passed.
- Final repository/broker focused check: 2 files, 20 tests passed.
- `npm run build`: TypeScript, renderer, and locked Rust build passed. Rust emitted only the existing filesystem hard-link fallback warnings.
- ESLint passed on all 24 changed TypeScript source/test files.
- Full `npm run lint` is polluted by ignored macOS AppleDouble `._*` sidecars already present throughout the mounted worktree; ESLint reports those binary metadata files, not tracked source. The changed-file ESLint run is clean.

## Implementation

- Shared adapter inputs and broker validation now accept `executionPolicy` for resume, fork, and rollback; broker fault reopen retains it and does not replay stale permission selection over delegated policy.
- `ExternalThreadRepository.executionPolicyForThread` resolves direct Delegation policy, treats legacy Delegation records as approval-required, inherits through fork lineage, defaults only genuinely ordinary Threads, and fails closed on cycles or missing lineage.
- External cold resume, fork, fork-based rollback, and last-Turn rollback pass the resolved policy to adapters. Delegated recovery does not replay a stale transport-token permission mode.
- Pi fails approval-required recovery as unsupported/non-retryable; unattended remains reachable.
- OMP restores approval-required as `always-ask` and unattended as `yolo`.
- OpenCode applies `ask`/`allow` natively on recovery and confirms the resulting projection.
- Claude Code restores `default`/`bypassPermissions` for approval/unattended.
- Grok explicitly fails both delegated recovery policies as unsupported/non-retryable because its recovery protocol cannot prove the native mode.
- DeepSeek Harness selects and confirms its safe catalog default for approval-required recovery, rejects danger-full-access as that default, and reapplies/validates its native unattended safety evidence.

## Files

- Adapter contract/broker: `packages/harness-adapter`, `packages/harness-broker`.
- Lifetime recovery: `packages/host-runtime/src/external-thread-{repository,runtime,fork,rollback}.ts` and focused tests.
- Adapter enforcement/tests: `packages/adapters/{pi,omp,opencode,claude-code,grok,deepseek-harness}`.

## Self-review and remaining concerns

- All unsupported recovery combinations are explicit fail-closed results; none return success without native evidence.
- Ordinary nondelegated recovery remains `default`, with existing ordinary resume tests included in the focused Gate.
- No dependency, storage-format, or Task 4 work was added.
- Grok delegated restart is deliberately unavailable until the native recovery protocol exposes authoritative permission-mode evidence.
