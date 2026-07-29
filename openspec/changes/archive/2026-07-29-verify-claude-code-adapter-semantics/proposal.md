## Why

The next HarnessAdapter slices need a second real Harness to reveal Pi-shaped assumptions before Tool, Cancel, Interaction, Native Session identity, and Fork semantics become expensive to change. Claude Code is the planned second Harness, but codexhost currently has no evidence-based integration baseline for the current Claude Agent SDK and the user's installed Claude Code binary.

## What Changes

- Add a Gate-only Claude Code capability probe based on the official Claude Agent SDK and a user-installed Claude Code executable.
- Verify create/prewarm side effects, multi-Turn streaming, Tool lifecycle, reliable native file-change data, interrupt convergence, Question versus Approval correlation, Native Session identity, history, resume, and exact Fork semantics.
- Record only reviewed, sanitized summaries and Fixtures; keep prompts, transcripts, credentials, complete native IDs, local paths, and raw captures in ignored local storage.
- Compare the official SDK facts with Paseo's independently implemented Claude provider to identify reusable architecture ideas and reject Paseo-specific Timeline persistence or inferred Diff behavior.
- Produce an explicit recommendation for the later minimal `ClaudeCodeAdapter` contract slice, including unsupported or still-unverified capabilities.
- Do not add Claude Code to Renderer Agent selection, Host routing, Mapping Store, release packaging, or public MVP support in this change.

## Capabilities

### New Capabilities

- `claude-code-adapter-semantics-probe`: Reproducible, capability-driven evidence for mapping the current Claude Agent SDK and Claude Code process into codexhost Host semantics without implementing the production Adapter.

### Modified Capabilities

None.

## Impact

- Adds development-only tooling and tests under `tools/` plus reviewed sanitized Fixtures under `tests/fixtures/`.
- May add the official Claude Agent SDK and required peer packages as development dependencies; production package ownership is deferred to the later Adapter change.
- Reads the user-installed Claude Code executable and existing native authentication/configuration only in explicitly requested live scenarios.
- Does not modify `packages/harness-adapter`, `packages/protocol-core`, `packages/host-runtime`, `packages/adapters/pi`, Renderer code, Mapping Store, or public runtime routing.
- The official SDK and Claude Code packages are Anthropic-owned and subject to Anthropic legal agreements. Redistribution, authentication eligibility, programmatic-usage billing, and release packaging require a separate product/legal decision before formal support.
