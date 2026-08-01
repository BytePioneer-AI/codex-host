## Why

The HarnessAdapter seam is already UI-independent, but Host control routing still contains Pi-only branches and the development-gated Claude Adapter reports contradictory availability and unsupported-operation semantics. These inconsistencies make a registered Adapter only partially substitutable and risk spreading Harness-specific conditions as more capabilities are added.

This corrective change keeps the current product scope and public Adapter shape. It removes proven layering leaks without introducing a base Session class, dynamic plugin system, new capabilities, or a broad refactor while the external Fork changes finish their real Desktop gates.

## What Changes

- Route Harness inspection through the registered Harness ID instead of a Pi-literal control schema and fixed Pi lookup.
- Route Thread Model selection through the owning HarnessSession and its declared capability instead of requiring Pi ownership.
- Keep transport-carrier decoding in Protocol Core while returning an opaque Harness Model Ref to generic Host Turn routing.
- Make the composition root the only production owner that constructs concrete Pi and Claude Adapters; AppServerHost receives an Adapter registry.
- Make Claude inspection truthfully distinguish an available executable from installation failure, while keeping Model selection, Snapshot, Resume, and Fork unsupported and development-gated.
- Reject missing Pi RPC Native Session identity as a protocol error instead of synthesizing a random identity.
- Narrow the Claude package root to its production Adapter surface so SDK transport and parser types remain package-private.
- Add focused contract and routing tests for the changed behavior; do not introduce a shared base class or conformance framework in this change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `registered-harness-routing`: Harness-level controls and Thread Model selection use the registered Adapter and owning Session without Pi-specific Host branches, and concrete Adapter construction remains in the composition root.
- `shared-runtime-contracts`: Harness inspection params accept a validated opaque Harness ID rather than only the Pi literal while remaining strict and browser-safe.
- `harness-adapter-text-session`: Native Session identity publication fails closed when the native Harness does not provide a stable identity.
- `claude-code-text-session`: Claude inspection reports executable readiness independently of Model catalog support, unsupported open modes return `unsupported`, and Claude SDK implementation types stay out of the package root.

## Impact

Affected production modules are `shared-contracts`, `protocol-core`, `host-runtime`, `adapters/pi`, and `adapters/claude-code`. Renderer behavior remains Pi-only for Model controls, but it consumes the renamed generic inspection params contract. Existing Mapping Store formats, Native Ref formats, HarnessAdapter methods, Codex transport tokens, Fork behavior, Worktree lifecycle, and public Pi product scope do not change.

This change is a narrow exception to the development checklist ordering requested by the user. It does not mark either active Fork change complete and does not replace their outstanding macOS or Windows Desktop gates.
