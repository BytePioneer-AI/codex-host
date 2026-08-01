## Context

The product baseline requires Slash Commands, Skill Commands, and ordinary input in an external Thread to be interpreted by that Thread's actual Harness. codexhost application actions must remain separate UI operations and must not occupy a Harness command namespace.

The formal architecture already sketches `HarnessAdapter.inspect({includeCommandCatalog:true})` for drafts and `HarnessSession.getCommandCatalog()` for live Sessions, but the production HarnessAdapter implements neither command catalog path. Pi RPC provides `get_commands` for Extension Commands, Prompt Templates, and Skills. It deliberately excludes interactive-only TUI commands such as `/model`, `/settings`, and `/hotkeys`. Pi RPC separately provides `compact` and `set_auto_compaction` controls.

The supported Codex Desktop currently owns slash matching in a private React/Jotai command registry. The analyzed `26.721.41059` asset merges two registration lists and de-duplicates descriptors by ID, but the currently installed `26.727.40816` build has not passed a slash-registry Gate. CSS-only hiding cannot satisfy command ownership because keyboard matching and a descriptor's `onSelect` can still consume a same-name command before `turn/start` reaches Host.

Paseo establishes the relevant provider pattern: a UI-neutral command catalog, draft and live-session queries, Provider commands inserted into the Composer, and a small set of Adapter-handled controls. For Pi, Paseo maps `get_commands`, adds `/compact` and `/autocompact`, and uses `agentInvoked` plus an idle barrier for Extension Commands that do not start an Agent Loop.

## Goals / Non-Goals

**Goals:**

- Add one UI-independent command catalog to HarnessAdapter and browser-safe Host/Renderer contracts.
- Discover the exact Pi command catalog for a draft cwd or current Native Session without leaking paths or native payloads.
- Expose Pi Extension Commands, Prompt Templates, Skills, `/compact`, and `/autocompact` in a Pi Composer.
- Ensure menu selection and manually typed same-name commands execute only through the Pi-owned Session.
- Preserve one accepted Host Turn lifecycle for commands whether or not Pi starts an Agent Loop.
- Restore untouched Codex slash behavior when the Composer selects Codex.
- Retain version/build checks, stale-request isolation, lazy durable Session behavior, and privacy-preserving evidence.

**Non-Goals:**

- Adding codexhost slash commands such as `/new`, `/clear`, or `/exit`.
- Exposing Pi TUI-only `/model`, `/settings`, `/hotkeys`, `/reload`, or arbitrary future built-ins without an executable RPC mapping.
- Adding `executeSlashCommand`, `executeNative`, a generic Renderer request bridge, or a second command execution endpoint.
- Replacing Codex Desktop project, Thread, Model, or Agent controls.
- Persisting command catalogs, observing catalog changes in real time, or modifying Mapping Store records.
- Supporting an unverified Desktop build, modifying the ASAR, or dynamically importing a second official asset module instance.
- Adding Claude Code command projection in this change; the abstraction must permit it later without Pi-specific Host or Renderer APIs.

## Decisions

### 1. Extend HarnessAdapter with one normalized read-only catalog

The browser-safe contract will define a bounded strict `HarnessCommandCatalog` containing descriptors with name, description, argument hint, and `command | prompt | skill | unknown` kind. `harness-adapter` will consume and re-export that shape. `HarnessSession.getCommandCatalog({refresh?})` will be optional only through a structural Session capability during migration, then required for Sessions that advertise command discovery.

Draft discovery will extend the existing `HarnessAdapter.inspect()` path with `includeCommandCatalog:true` and the exact normalized cwd plus current supported configuration. Live discovery will call `HarnessSession.getCommandCatalog()` on the owning Session. The catalog is read-only and is not Session state, so this change adds no `session.commands.changed` output.

Catalog entries are executable promises, not documentation scraped from files. Names omit the leading slash, are non-blank, bounded, unique, and deterministically ordered. Native source paths, package locations, executable paths, arbitrary metadata, and Provider credentials are discarded before the public boundary. `unknown` is used when a Harness cannot classify a command reliably; descriptions are never used to infer kind.

Alternative: put Pi `get_commands` response types in shared contracts. Rejected because Host and Renderer must remain independent of Pi RPC.

Alternative: add a generic `executeSlashCommand(name,args)`. Rejected because menu selection and manual input would gain different execution paths, and native protocols would escape through the Adapter boundary.

### 2. Use draft inspection and live Session queries without creating a persisted catalog

A new Pi draft uses the same ephemeral inspection process that reads the Model catalog. When command discovery is requested, that process also calls `get_commands` and closes on success or failure without submitting a Prompt, creating a durable Native Session, or writing user configuration. The exact project cwd and trust behavior are inherited from Pi; Host process cwd is never used as a fallback for a missing Composer cwd.

An opened and started Pi Session queries its existing RPC process so the result reflects resources loaded by that Native Session. A not-yet-started Session may reuse a matching in-memory draft result or perform bounded ephemeral inspection; it must not create a durable Native Session merely to populate autocomplete.

Host may coalesce identical in-flight draft queries and use a short process-local cache keyed by Harness, cwd, Model, Thinking, and other normalized inspection inputs. Live results are keyed by loaded Session identity. Model/Thinking changes, explicit refresh, Session close, or mismatched configuration invalidate the relevant entry. No cache survives Host restart.

Alternative: scan `.pi` and user directories in Host. Rejected because Pi owns package, trust, settings, collision, and discovery semantics.

Alternative: use one global Pi catalog. Rejected because project Extensions, Templates, Skills, trust, and Session configuration vary by cwd and Session.

### 3. PiAdapter maps three native sources and two explicitly enhanced controls

PiAdapter maps `get_commands` as follows:

```text
source=extension -> kind=command
source=prompt    -> kind=prompt
source=skill     -> kind=skill
```

PiAdapter prepends Adapter-enhanced `/compact [instructions]` and `/autocompact [on|off|toggle]`. They are ordinary `kind=command` descriptors at the public boundary but are documented and tested as Adapter enhancements, not commands returned by `get_commands`. If Pi reports either same name, the catalog contains one entry and PiAdapter's explicit control execution semantics take precedence while preserving a valid native description and the known argument hint.

Other Pi built-ins are excluded unless a later change identifies a supported official RPC and adds explicit execution and lifecycle requirements. Unknown user input beginning with `/` is still passed to Pi rather than rejected or rerouted to Codex.

Alternative: include every Pi TUI command for visual parity. Rejected because interactive-only built-ins do not execute through RPC `prompt` and would make the catalog dishonest.

### 4. All selected and manually typed commands use the normal Turn route

Selecting a Provider command only replaces the active slash token with canonical text such as `/skill:code-review `; it does not invoke Host directly. Submission continues through the existing `turn/start` route and the Thread's immutable Harness ownership.

PiAdapter parses accepted string input only to recognize its two enhanced controls. `/compact` invokes Pi RPC `compact`; `/autocompact` validates `on|off|toggle`, reads state for toggle, then invokes `set_auto_compaction`. All other input, including Extension, Prompt, Skill, and unknown slash text, is sent through Pi RPC `prompt` unchanged. Host and Renderer contain no Pi command-name switch.

An enhanced control retains the same observable Host Turn contract as other accepted input: exactly one `turn.started`, any mapped timeline Items or status messages, and exactly one terminal result. It cannot bypass ownership, persistence ordering, cancellation, or Session fault handling.

Alternative: execute controls immediately from the menu. Rejected because manually typed commands would behave differently and Renderer would acquire Pi RPC semantics.

### 5. Complete no-Agent-loop Pi commands using correlated prompt results and idle state

Pi RPC prompt responses are correlated to the active Host Turn. If the response reports `agentInvoked:false`, PiAdapter waits through the current event loop and confirms the Session is not streaming before completing the Turn. Notifications or supported Extension UI Requests emitted before that barrier remain associated with the accepted Turn. If `agent_start` or `turn_start` arrives first, the normal Agent settlement path owns completion.

The Adapter buffers no-Agent-loop notices and maps displayable Extension notifications according to the existing Item/notice rules. Supported `select`, `confirm`, `input`, and `editor` requests continue through the established Question bridge. A complex custom TUI that cannot be represented must return an explicit unsupported outcome; it must not be declared successful merely because no Agent ran.

A missing, contradictory, or uncorrelated prompt result cannot be guessed into success. The Adapter performs a bounded state check and returns a normalized failure or faults the Session when ordering can no longer be proven.

### 6. Reuse one fixed draft inspection method and add one fixed live catalog method

Drafts extend the existing fixed `codexhost/harness/inspect` request with command-catalog inclusion and exact cwd/configuration fields. Existing consumers can omit the new optional fields and retain current Model inspection behavior.

Existing Threads use a new fixed `codexhost/thread/commands/list` method containing only a bounded Host Thread ID and optional refresh. Host resolves persisted ownership first, obtains or restores the owning external Session through generic routing, and calls `getCommandCatalog()`. Codex-owned, unknown, unsupported, or unavailable Threads return explicit typed errors and are never forwarded to official Codex.

Responses are validated at both Host and Renderer boundaries with strict shared schemas. There is no arbitrary method/payload envelope, Pi RPC name, source path, Native Ref, Prompt, Transcript, or credential in either contract.

Alternative: expose the recovered request manager to Renderer. Rejected because it would broaden the current fixed-control security boundary.

### 7. Replace behavior per Composer; visual hiding alone is forbidden

When the current logical Composer selects Pi, the versioned Renderer integration must remove Codex command descriptors from matching and keyboard selection for that Composer before showing Pi results. It may retain ordinary Desktop operations outside the slash surface, but this change adds no application slash commands. When the Composer selects Codex, the original registry and behavior remain unchanged.

The first implementation Gate will inspect the currently supported Desktop asset and choose one of two versioned mechanisms:

1. Adapt the active page's actual slash registry/store when it can be uniquely recovered from the mounted Composer Fiber and mutated or registered through the same live state instance.
2. Install a Pi-only autocomplete controller that captures slash matching and keyboard/mouse selection before Codex and suppresses the stock popup and handlers for that Pi Composer.

Both mechanisms are held to the same behavioral requirements. Dynamic import of a second official module instance, CSS-only hiding, global permanent registry mutation, command-ID ordering, and DOM text scraping are not acceptable seams. If neither mechanism can prove that a typed same-name command cannot run Codex `onSelect`, Pi slash projection is unavailable for that build.

The controller queries only for an active Pi Composer. Draft requests use a structurally verified exact project cwd; existing conversations use the validated current-process Host Thread ID. Missing or ambiguous cwd/Thread identity produces an unavailable command menu rather than a query against Host cwd. Agent changes, Composer replacement, target changes, refresh, and disposal advance a request generation so stale catalogs cannot update a newer Composer.

### 8. Treat command content as untrusted display data

Shared schemas bound command count and field lengths. Renderer creates text nodes or equivalent escaped React text and never assigns command content to HTML. It does not expose native source paths. Names are validated as command tokens but are not interpreted as CSS selectors, DOM IDs, request methods, or file paths.

Catalog and Gate diagnostics may record counts, normalized kinds, duplicate/collision outcomes, anonymous Composer identity, and selected Harness. They must omit command descriptions from user files, arguments, Prompt content, Transcript, native paths, credentials, raw Model values, complete request IDs, and complete Thread IDs.

### 9. Validate backend semantics before enabling the private UI integration

Hermetic tests first establish schema bounds, generic Fake Adapter routing, Pi mapping, control execution, no-Agent-loop settlement, stale queries, and Codex transparency. A current-build Renderer Gate then proves registry/controller ownership with a fake catalog containing a deliberate Codex/Pi same-name collision. Only after that passes does a real Pi Gate verify project Extension, Prompt, Skill, compact, and autocompact behavior.

The Gate must prove keyboard and mouse selection, manually typed same-name input, draft-to-conversation replacement, Codex-to-Pi-to-Codex draft switching, existing Thread query, unknown slash routing, and cleanup. A visual screenshot without route evidence is insufficient.

## Risks / Trade-offs

- [The current Desktop registry cannot be uniquely recovered] -> Use the versioned Pi-only controller only if it can suppress stock keyboard and selection behavior; otherwise mark command projection unsupported for that build.
- [A hidden Codex command still consumes Enter] -> Gate deliberate same-name commands and observe that no official Codex command request is emitted before enabling the feature.
- [Draft cwd cannot be proven from the Composer] -> Keep the catalog unavailable and add no Host-cwd fallback; ordinary non-command Pi input remains governed by the existing routing readiness.
- [Ephemeral Pi inspection is slow] -> Coalesce the existing Model and command inspection, use bounded process-local caching, and show stable loading without blocking already available ordinary text unnecessarily.
- [Extensions change commands after startup] -> Live Session queries and explicit refresh provide current state; this change intentionally adds no real-time catalog event.
- [An Extension depends on unsupported custom TUI] -> Map supported Questions and fail explicitly for unsupported interaction instead of claiming command success.
- [An Adapter-enhanced name collides with an Extension] -> Publish one deterministic descriptor and reserve execution of the explicitly enhanced control; cover the collision in tests.
- [Private structures drift after Desktop update] -> Build whitelist, structural uniqueness checks, real behavioral Gate, and fail-closed availability remain mandatory.

## Migration Plan

1. Add delta specs and strict shared command schemas without enabling Renderer behavior.
2. Extend HarnessAdapter/Fake Adapter command discovery and add generic Host draft/live query routing.
3. Implement Pi `get_commands`, controls, and no-Agent-loop settlement with focused real-Pi protocol tests.
4. Prove exact draft cwd and active slash behavior on the current supported Desktop build.
5. Implement the successful versioned Renderer mechanism behind its readiness checks.
6. Run package checks, builds, strict OpenSpec validation, and privacy-preserving real Desktop/Pi Gates.
7. Update the implementation checklist and verification record only after the behavioral collision Gate passes.

Rollback disables the Renderer command capability and removes the fixed live catalog method while retaining ordinary Pi Turn routing. No persisted data, Native Session format, user Pi configuration, or official Codex catalog requires migration or cleanup.

## Open Questions

- Can the current `26.727.40816` build expose the active slash registry/store uniquely, or must the implementation use a Pi-only autocomplete controller?
- Which structurally verified Composer value is the authoritative draft cwd in the current build? This must be resolved by the initial Renderer Gate before draft catalog implementation.
