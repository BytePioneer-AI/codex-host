# Change: Peer Remote Delegation (Phase 1)

## Why

1. `packages/web-server/src/peer-host-manager.ts` currently only checks `ctx.auth`, missing the `ctx.auth.local === true` gate documented for `codexhost/remote-peers/{add,update,remove,test}`. A remote authenticated Web session can therefore mutate peer topology or trigger outbound probes.
2. Agents running inside codexhost can read Codex Desktop remote threads (`remote-ssh*` / `remote-control:*`), but cannot discover paired `remote-peer:<peerId>` hosts or delegate/control sessions across paired machines without exposing Peer tokens or arbitrary URLs.

## What Changes

- Enforce `ctx.auth.local === true` on `codexhost/remote-peers/{add,update,remove,test}` while keeping `list`, `reconnect`, and workspace/directory operations open to all authenticated sessions.
- Extend `@codexhost/shared-contracts` with `capabilities.delegation: 1` on Peer manifests, fixed-whitelist Peer delegation request/response/bridge schemas, and the `codexhost/peer/delegation` Client Channel method.
- Add B-side `POST /api/peer/v1/delegation` in `@codexhost/web-server` (guarded by existing auth, same-origin check, capability toggle, and 1-hop limit) forwarding through Client Channel to B's `DelegationControlRegistry`, while blocking `codexhost/peer/delegation` on `/api/ch/v1/rpc`.
- Add A-side loopback-only private bridge (`peer-delegation-bridge-v1.json`, `0600`) in `@codexhost/web-server` so A's `@codexhost/host-runtime` can list paired Peers and forward whitelisted operations over `PeerHostClient` without reversing package boundaries or exposing Peer tokens/URLs to Agents.
- Generalize `DelegationControlRegistry`, `delegation-control-server`, `delegation-cli`, and MCP tools to support `codexhost host list` and `--host <remote-peer:...>` / `thread://<id>?hostId=...` for `read`, `wait` (A-side bounded polling), `send` (with `steer`/`interrupt`), `cancel`, `answer`, `delegate start` (with B-side `worktree`/`base`), `thread list`, `harness list`, and `harness inspect`, enforcing a strict 1-hop loop limit and preserving Codex Desktop read-only boundaries.

## Out of Scope (Phase 1)

- Cross-host `thread watch` persistence/polling (rejected with `UNSUPPORTED` in Phase 1).
- Multi-hop forwarding (`A -> B -> C` or `A -> B -> A`).
- Per-token delegation scopes UI or cross-host sidebar delegation tree UI.
- Extending Codex Desktop (`remote-ssh*` / `remote-control:*`) remote channels beyond `thread read`.
