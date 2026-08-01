## Why

Pi Threads currently inherit Codex Desktop's slash-command catalog even though Codex owns those command actions and Pi exposes a different executable catalog through RPC. This can hide Pi Extensions, Prompt Templates, and Skills, and a same-name Codex command can consume input before the Pi-owned Turn reaches Host routing.

## What Changes

- Add a UI-independent Harness command-catalog contract that reports only commands the owning HarnessSession or Adapter can actually execute.
- Query Pi RPC `get_commands` for Extension Commands, Prompt Templates, and Skills, and normalize them without exposing native paths or Pi RPC payloads.
- Add Adapter-handled Pi `/compact` and `/autocompact` commands backed by Pi's explicit RPC controls rather than ordinary Prompt text.
- Correct Pi command Turn settlement for Extension Commands that complete without starting an Agent Loop, including supported Extension UI interactions.
- Add fixed, browser-safe Host command-catalog requests for an existing external Thread and a new draft identified by Harness plus exact cwd; do not expose a generic request bridge.
- On a supported Codex Desktop build, replace Codex slash-command matching and selection behavior for a Pi Composer with the Pi catalog, including keyboard and mouse handling, same-name isolation, stale-result protection, and restoration of the original Codex behavior when Codex is selected.
- Keep Codex Desktop application operations in their existing UI. This change does not add codexhost slash commands such as `/new`, `/clear`, or `/exit`.
- Exclude Pi TUI-only commands such as `/settings`, `/model`, and `/hotkeys` because Pi RPC cannot invoke them.

## Capabilities

### New Capabilities
- `harness-command-catalog`: Defines normalized command discovery, provenance-independent command kinds, draft and live-Session consistency, executable catalog semantics, and Adapter-owned command execution.

### Modified Capabilities
- `harness-adapter-text-session`: Expands the production Session interface from the first text-only slice with read-only command-catalog discovery while preserving the finite UI-independent boundary.
- `shared-runtime-contracts`: Adds strict browser-safe command catalog and fixed command-inspection request/response schemas.
- `registered-harness-routing`: Routes draft and existing-Thread command discovery through the registered or owning HarnessAdapter without Harness-specific Host branches.
- `pi-model-routed-vertical-slice`: Discovers and executes Pi Extension, Prompt, Skill, compact, and autocompact commands with correct Turn and interaction lifecycles.
- `versioned-renderer-agent-routing`: Replaces Codex command matching for Pi Composers on supported builds and restores stock behavior for Codex Composers.

## Impact

- Affected packages: `shared-contracts`, `harness-adapter`, `adapters/pi`, `host-runtime`, `renderer-extension`, and supporting protocol/control clients and tests.
- Affected private integration: the build-whitelisted Codex Renderer slash registry or, if that registry cannot be uniquely adapted, a versioned Pi-only autocomplete controller with equivalent behavioral isolation.
- Real validation requires the current supported Codex Desktop build and local Pi RPC, with sanitized evidence that records command kinds and ownership but not command source paths, Prompt content, Transcript, credentials, or complete Thread IDs.
- No Mapping Store migration, Native Session format change, user configuration write, Codex command catalog mutation, ASAR modification, or new runtime dependency is required.
