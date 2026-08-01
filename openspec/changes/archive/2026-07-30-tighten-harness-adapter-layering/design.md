## Context

The public HarnessAdapter already separates Host semantics from Pi RPC and Claude Agent SDK details. Generic External Thread create, Turn, output, history, resume, and Fork paths use the Adapter registry, but adjacent control paths still inspect Pi directly: Harness inspection uses a Pi-literal schema, Thread Model selection checks Pi ownership, selected transport Model decoding is called from a Pi branch in Host, and AppServerHost can construct Pi even though a composition root already exists.

Claude Code remains an explicitly development-gated calibration Adapter. Current planning changes allow create-mode stable Native Turn identity while Snapshot, Resume, and Fork remain unsupported. This change works with that decision rather than expanding Claude into a supported persistent Harness.

The repository checklist says the active Fork changes should finish real Desktop gates before the next Change. This user-requested corrective Change is therefore limited to layering and fail-closed behavior, does not alter Fork semantics, and does not claim or replace either outstanding Gate.

## Goals / Non-Goals

**Goals:**

- Make existing Harness inspection and Model control dispatch use the Adapter registry, Thread ownership, and declared capabilities.
- Keep transport token syntax and decoding in Protocol Core while giving Host only an opaque Harness Model Ref.
- Leave concrete Adapter construction at the production composition root.
- Make Claude inspection and unsupported operations semantically honest without adding product support.
- Reject missing Pi Native Session identity at the raw transport parser.
- Keep concrete Harness SDK and test transport types out of the Claude package root.

**Non-Goals:**

- Adding HarnessAdapter methods, history capabilities, a dynamic plugin system, or a native escape hatch.
- Implementing Claude Snapshot, Resume, Fork, Model selection, Tool projection, or product registration.
- Introducing `BaseHarnessSession`, a generic transport, or a new conformance framework.
- Moving the existing Pi Session implementation solely to reduce file size.
- Changing Mapping Store records, Native Ref schemas, transport tokens, Renderer Agent availability, or Desktop Fork behavior.

## Decisions

### 1. Generalize dispatch, not Harness-native encoding

The shared inspection params become `{ harnessId, cwd?, refresh? }` using the existing browser-safe `HarnessId` schema. Host looks up that ID in its finite registered Adapter map and calls `inspect()`. An unknown or unregistered Harness returns an explicit unavailable error.

Thread Model selection resolves the Thread first, checks `session.capabilities.configuration.selectModel`, then executes the existing `model.select` command. It does not branch on Harness ID. The effective Model is still confirmed through the existing ordered Session state observer.

Protocol Core retains the finite Desktop transport registry and exposes one decoder that accepts the owning external Harness ID plus the wire Model value. Pi's selected carrier remains Pi-specific inside Protocol Core; Harnesses without an encoded Model carrier accept only their base transport token. Host receives only `HarnessModelRef | null | undefined`.

Alternative: move transport carrier parsing into HarnessAdapter. Rejected because those values are Codex Desktop protocol carriers, not Native Harness configuration.

Alternative: create a dynamic Adapter/plugin registry. Rejected because only two finite external transport tokens exist and the current registry already provides the required seam.

### 2. AppServerHost requires composed Adapters

`main.ts` and the existing adapter composition module remain responsible for constructing Pi and optionally Claude. AppServerHost receives a `ReadonlyMap<ExternalHarnessId, HarnessAdapter>` and never imports or constructs a concrete Adapter. Hermetic tests construct explicit Fake maps.

Alternative: keep the Pi fallback for convenience. Rejected because it creates a second composition path and allows production behavior to differ depending on which constructor option a caller happens to use.

### 3. Claude remains development-gated but reports truthfully

Claude `inspect()` resolves the configured user executable without opening an SDK Query or creating a Native Session. A resolvable executable returns `ready` with an empty Model catalog and `selectModel=false`; resolution failure returns the normalized installation error. Lack of Model catalog support does not make an executable Harness unavailable.

`open(create)` remains lazy. `open(resume|fork)` returns `unsupported`, while malformed create input remains `invalidRequest`. `readSnapshot()` remains `unsupported`. This aligns behavior with the current development-gated planning decision and does not pretend that Claude Threads are recoverable.

The package root exports the production Adapter, options, and package metadata. Adapter tests import private transport/parser modules relatively; cross-package tests derive injected dependency types from the Adapter constructor instead of importing Claude-native transport types from the package root.

Alternative: add `history.read` and `history.resume` capabilities. Rejected because Snapshot and Resume are baseline semantics for a production persistent Adapter; adding booleans only to legitimize an intentionally incomplete development Adapter would weaken the seam.

### 4. Pi Native identity fails at the transport parser

Pi RPC `get_state` must contain a non-blank `sessionId`. Missing or blank identity raises `PiRpcFaultError("protocolError")`. PiAdapter therefore never publishes or persists a locally generated fallback identity.

The change does not remove Pi RPC `clone`, alter Fork selection, or reorganize Pi files because active history/Fork specifications and Gates still reference those operations.

### 5. Prefer focused tests over a shared lifecycle framework

Tests cover generic Host inspection and Model selection with two Fake Harness IDs, explicit composition, Claude inspect/unsupported results, and missing Pi identity. Existing Adapter lifecycle tests remain separate.

A reusable concrete-Adapter conformance suite and common Session finalizer may become justified after Claude implements the full persistent contract or a third Adapter appears. Introducing them now would add callbacks and generic state machinery without reducing current caller complexity.

## Risks / Trade-offs

- [Existing tests rely on AppServerHost's implicit Pi fallback] -> Update fixtures to inject the same Fake Pi map explicitly; production already uses the composition root.
- [A generic Model decoder accidentally accepts a foreign carrier] -> Keep a finite decoder table in Protocol Core and test base, selected, malformed, and cross-Harness carriers.
- [Claude ready inspection is mistaken for product support] -> Keep composition and Renderer development gates unchanged; return an empty catalog and false capabilities.
- [The user's concurrent Claude planning changes are overwritten] -> Edit only additive or directly compatible sections and preserve their stable Native Turn identity work.
- [Deferred Pi file size remains costly] -> Keep the internal transport/history/session-file modules as current responsibility anchors and revisit physical splitting only with a behavior change that benefits from it.

## Migration Plan

1. Add delta specs and focused tests for generic control routing and fail-closed identity.
2. Rename the shared inspection params contract and update Renderer/Host consumers without changing the wire shape used for Pi.
3. Move concrete construction out of AppServerHost and update all fixtures to inject maps.
4. Tighten Claude and Pi behavior, then run focused tests, full checks, build, and strict OpenSpec validation.

There is no persisted-data migration. Rollback restores the prior control dispatch and Adapter behavior without modifying Native Sessions or Mapping Store records.

## Open Questions

None for this Change. Claude persistent history and a possible Pi internal file split remain separate future decisions.
