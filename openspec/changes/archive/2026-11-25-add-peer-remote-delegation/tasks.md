# Tasks: Peer Remote Delegation (Phase 1)

- [x] 1. Enforce `ctx.auth.local === true` on `add`, `update`, `remove`, `test` in `packages/web-server/src/peer-host-manager.ts` and add unit tests.
- [x] 2. Extend `packages/shared-contracts` (`remote-peers.ts`, `client-channel.ts`, `peer-delegation.ts`, `index.ts`) with `capabilities.delegation`, `PEER_DELEGATION_CHANNEL_METHOD`, and strict request/response/bridge schemas.
- [x] 3. Implement B-side `POST /api/peer/v1/delegation` in `packages/web-server`, advertise `capabilities.delegation: 1` when enabled, and block `codexhost/peer/delegation` on `/api/ch/v1/rpc`.
- [x] 4. Implement A-side private loopback bridge (`peer-delegation-bridge-v1.json`, `0600`) and `PeerHostClient.delegate` (no auto-retry) in `packages/web-server`.
- [x] 5. Wire `codexhost/peer/delegation` in `packages/host-runtime` (`shared-host-service.ts`, `run-host-runtime.ts`, `app-server-host.ts`, `delegation-control-registry.ts`) with B-side worktree creation and 1-hop loop guard.
- [x] 6. Generalize `DelegationControlRegistry`, `delegation-control-server.ts`, `external-client-routes.ts`, `external-client-mcp.ts`, and `delegation-cli*` for `host list` and `remote-peer:*` operations while keeping Desktop hosts read-only.
- [x] 7. Add focused unit tests and dual-node loopback integration tests, then verify `tsc -b`, focused tests, and `node tools/check-boundaries.mjs`.
