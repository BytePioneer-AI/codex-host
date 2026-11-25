# Design: Peer Remote Delegation (Phase 1)

## Trust Model & Security Boundary

- **Single-OS-User (Same-UID) Trust Boundary**: Consistent with existing `codexhost` local files (`remote-peers-v1.json`, `cli-credentials.json`, all `0600` under the user's data directory), Phase 1 runs within a single OS user's trust boundary and does not provide cross-OS-user sandboxing.
- **1-Hop Limit as a Cooperative Anti-Recursion Guardrail**: The 1-hop limit protects cooperative delegation call paths against `A -> B -> A` and `A -> B -> C` recursion loops rather than acting as an OS sandbox against an arbitrary same-UID shell:
  - **External Harness sessions** receive per-Thread HMAC-SHA256 bound bearer tokens (`cht_<b64url(threadId)>.<hex64>`). The control server verifies the bound Thread ID and ignores any `callerThreadId` in the request body.
  - **Native Codex Threads** share a single official `codex app-server` process whose `thread/start` RPC provides no per-Thread environment injection. Native Codex therefore uses the shared Runtime token with `CODEX_THREAD_ID`, and the Registry restricts that shared token strictly to active native Codex Thread IDs (`activeNativeThreadIds`, never accepting external Harness Thread IDs), backed by persisted delegation ancestry (`getDelegationByChild`).
  - **Independent External Clients (HTTP / MCP)** authenticate via client credentials, strip any body `callerThreadId`, and are treated as 0-hop callers.
  - **Fail-Closed Lineage & Anti-Laundering**: Ancestry lookup failures, cycles, or depth exceeding 64 hops fail closed with `FORBIDDEN`. When a remotely initiated Thread spawns a local child Thread, the Registry forces the persisted parent to that caller before Turn 1 starts so explicit plain `parentThreadId` arguments cannot launder remote origin.

## Architecture & Package Boundaries

- `@codexhost/shared-contracts`: Browser-safe schemas and constants only (no Node built-ins or workspace imports).
  - `remotePeerCapabilitiesSchema.delegation?: 1`
  - `clientChannelDescriptorSchema.capabilities?: { peerDelegation?: 1 }`
  - `PEER_DELEGATION_CHANNEL_METHOD = "codexhost/peer/delegation"` (internal channel method, not exported in public `CLIENT_CHANNEL_METHODS`)
  - `PEER_DELEGATION_OPERATIONS`: `listHarnesses`, `inspect`, `start`, `send`, `cancel`, `read`, `answer`, `list`
  - `PEER_DELEGATION_MAX_HOPS = 1`
  - `PEER_DELEGATION_BRIDGE_DIR = "peer-delegation-bridges"` (per-instance `bridge-<pid>-<instanceId>.json` descriptors)
- `@codexhost/web-server` depends on `@codexhost/shared-contracts` and `@codexhost/desktop-control`; `@codexhost/host-runtime` never imports `@codexhost/web-server`.

## B-Side Execution & Idempotency

1. B's Web server advertises `capabilities.delegation = 1` in `GET /api/peer/v1/manifest` only when `chHost.realtime?.peerDelegationSupported()` is true (Runtime descriptor declares `capabilities.peerDelegation === 1`) and `CODEXHOST_DISABLE_PEER_DELEGATION !== "1"`.
2. `POST /api/peer/v1/delegation` runs behind B's existing `AccessAuth` and `trust.sameOrigin` checks, validates the strict request schema and `hopCount === 1`, derives a per-Peer `sourceId` scope, and forwards to B's `host-runtime` via `chHost.realtime.request("codexhost/peer/delegation", payload)`.
3. `serveChClientGateway` rejects `codexhost/peer/delegation` on `/api/ch/v1/rpc` so callers cannot bypass `/api/peer/v1/delegation` or B's disable flag.
4. B's `startClientChannelServer` routes `codexhost/peer/delegation` exclusively through its `peerDelegation` option to `DelegationControlRegistry.handlePeerDelegationChannelRequest`:
   - Re-validates schema, `hopCount === 1`, and rejects nested remote `hostId` targets.
   - For `operation === "start"`, serializes per `requestId` and checks both the in-memory cache and the durable `FilePeerStartIdempotencyStore` (`<dataDir>/peer-delegation-requests/`, storing canonical request hash including `cwd`/`worktree`/`base` plus resolved `{ path, branch, base }` result) BEFORE invoking `startWithDelegationWorktree` locally on B. Both warm and post-restart cold replays for native Codex and external Harnesses return the exact original result and reject mismatched `base`/branch/task before touching Git.
   - Assigns a per-Peer synthetic parent origin `peer:<scope>` (isolating implicit dedup across Peers and excluded from sidebar parent trees and ref inheritance).
   - Persists delegation records (`status: "creating"`) before Turn 1 starts on both native Codex and external Harnesses.
   - Returns fixed, client-safe `{ ok: true, value }` or `{ ok: false, error: { code, message, details? } }` without raw exception messages, stack traces, host paths, or Peer credentials.

## A-Side Private Loopback Bridge & Registry Routing

1. A's Web server starts a loopback-only (`127.0.0.1`) HTTP bridge requiring a 64-hex-char Bearer token and rejecting any `Origin` header (including empty `Origin: ""`), writing a per-instance `0600` descriptor under `<codexhostDataDir>/peer-delegation-bridges/bridge-<pid>-<instanceId>.json` atomically and removing only its own file on shutdown.
2. The bridge handles:
   - `operation: "hosts"`: returns enabled peer summaries (`hostId`, `displayName`, `online`, `state`, `delegation`, `projects`, `platform`, `hostname`, `homeDir`) with no tokens or origin URLs.
   - Whitelisted operations for `remote-peer:<peerId>`: verifies peer is enabled, connected, and declares `capabilities.delegation === 1`, issues a single non-retried `POST /api/peer/v1/delegation` via `PeerHostClient`, and independently re-sanitizes remote HTTP 200 `{ ok: false, error }` envelopes at the A boundary (fixed client-safe message + allowlisted `details`, stripping host paths and unknown fields).
3. A's `DelegationControlRegistry`:
   - Verifies caller identity and fail-closed hop lineage before any remote call.
   - Preserves same-host `executionHostId === targetHostId` local read optimization and never forwards `callerThreadId` to remote hosts.
   - Routes `remote-peer:*` to the bridge; implements `wait` with a single unified `performance.now()` deadline and shared `AbortController` covering initial caller/lineage verification (performed once), bridge discovery, per-read timeout/abort, and expiry checking before accepting any terminal snapshot.
   - Keeps `remote-ssh*` / `remote-control:*` strictly read-only via existing Desktop `read-thread`, rejecting mutations and wait without local fallback.
   - Rewrites remote `deepLink` and `next.{read,wait}` hints to `thread://<id>?hostId=<encoded-host-id>`.

## CLI, Control Server & MCP

- `codexhost host list` and MCP `host_list` query `/v1/host/list`.
- `delegate start`, `thread list`, `harness list`, `harness inspect`, `thread send`, `thread wait`, `thread cancel`, `thread answer` (including `--format text`), and `thread read` accept `--host <hostId>` and `thread://<id>?hostId=...`.
- Direct HTTP routes and MCP tools uniformly parse `thread://<id>?hostId=...` via `parseThreadReferenceInput`, preserving `hostId` and rejecting unsupported cross-host `watch`/`export`/`file` before accessing local Threads.
