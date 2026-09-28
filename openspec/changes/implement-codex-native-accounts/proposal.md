## Why

Global Codex Account switching needs to replace actual native credentials while retaining the official backend and permanent Thread store. The previous transaction/recovery implementation added persistent coordination that is unnecessary when atomic auth replacement leaves one complete native identity.

## What Changes

- Use one canonical `CODEX_HOME` and one capability-token-protected loopback app-server shared by Desktop clients and a management connection; initialize Account management asynchronously without blocking native use.
- Store metadata and exact native credential text for every saved Account in a Node fs plaintext v3 Vault; derive current only from permanent `auth.json`.
- Read and rewrite 0.8.x v1/v2 Vaults, salvage missing copies or unknown identities once from leftover Account records, then delete those records. Preserve corrupt Vaults and disable management only.
- Switch by saving A, checking file storage and environment overrides, stopping the owned backend and the executable-name-matched external Codex batch, saving A again, atomically installing B, restarting and verifying native identity. Restore A on failure; recover restarts and verifies the current file.
- Remove Journals, durable recovery stages, process exit records, supervisor receipts, Rust private-file IPC, OS keyring access and public cleanup state.
- Run Settings device-code login in a separate short-lived private home while the main backend continues. Save the result; install only with no current Account or a re-login of current. Forward Desktop native authentication unchanged.
- Retain v2 global state, generation-safe lazy native Thread resume, selected-Thread navigation restoration, inactive WHAM quota reading and single-flight OAuth refresh.
- Keep SSH remote native single-account authentication.

## Non-goals

- Model proxies, per-Account backends, per-Thread Account routing, automatic Account rotation or history merging across homes.
- Multi-client atomic switching or lossless temporary content and full runtime settings restoration.
- Deferred: consolidating OfficialWorkGate lease kinds, choosing one Thread restoration path, narrowing external termination to the same home or app-server only, and re-evaluating inactive OAuth refresh.

## Capabilities

### New Capabilities

- `codex-native-global-accounts`: Global switching, native admission and authentication, Thread continuity, public state and native fallback.
- `codex-native-credential-lifecycle`: Plaintext v3 Vault, one-time legacy record collection, atomic replacement, isolated parallel login and unchanged quota behavior.

### Modified Capabilities

No Harness plugin contract changes. Account v2 exposes global native-derived state; only Settings offers global switching.

## Impact

Host Runtime, shared Account contracts, Renderer and generic native process integration are simplified. New implementation validation is pending; see `tasks.md` and `evidence.md`.
