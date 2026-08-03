## Context

The shared HarnessAdapter already models Command Execution, Generic Tool, File Change, bounded output, Item outcomes, and ordered Turn completion. Protocol Core already projects those Items into Codex Desktop `commandExecution`, `dynamicToolCall`, `fileChange`, `item/fileChange/patchUpdated`, and `turn/diff/updated` messages. PiAdapter proves this contract, but ClaudeCodeAdapter currently drops Assistant `tool_use`, User `tool_result`, `tool_progress`, and `tool_use_result` while retaining only text, reasoning, and Interaction events.

The pinned official Claude Agent SDK exposes complete Tool Use blocks in Assistant messages, matching Tool Result blocks in User messages, and a per-message structured `tool_use_result`. Prior live and hermetic Gates proved Tool Use ID correlation and native Edit/Write `structuredPatch` output. Tool Progress was optional and omitted in observed long Bash runs. The implementation must keep SDK values private, preserve existing Approval/Question behavior, and avoid deriving file changes from Tool input, Git, or filesystem state.

## Goals / Non-Goals

**Goals:**

- Project live Claude Bash and ordinary Tool lifecycles through the existing Host Item contract.
- Produce File Change Items only from successful, validated native Edit/Write structured patches.
- Preserve Tool correlation and close every started Item before the Turn terminal under success, failure, cancellation, close, and malformed lifecycle races.
- Keep Tool output bounded before it crosses the Adapter boundary.

**Non-Goals:**

- Complete historical Tool/File Change restoration, stable historical Tool Item identity, or Claude Fork.
- New HarnessAdapter variants, Host Runtime routing, Protocol Core projection, or Renderer UI.
- File changes inferred from Tool input, Git, file watching, before/after snapshots, Bash commands, or unknown result fields.
- Claude Code public product support or release-policy decisions.

## Decisions

### 1. Interpret native Tool messages inside the Claude transport

`ClaudeNativeTurnAccumulator` remains the single ordered interpreter for SDK messages and emits private `tool.started`, `tool.progress`, and `tool.completed` events alongside text and reasoning. Tool Use ID is the private correlation key. A complete Assistant `tool_use` block starts a Tool because it contains validated complete arguments; partial input JSON is not published. A matching User `tool_result` completes it and carries bounded text/image candidates plus a finite normalized native result for known Tools.

Known malformed starts, duplicate IDs, mismatched results, or a Turn Result with unresolved Tools produce a protocol failure. Unknown SDK message types remain ignored when they do not break known lifecycle correlation.

Alternative: interpret SDK Tool messages in `ClaudeHarnessSession`. Rejected because it would expose SDK message shapes above the private transport boundary and duplicate Query sequencing concerns.

### 2. Treat Tool Progress as optional metadata

SDK `tool_progress` references Tool Use ID and elapsed time but does not provide cumulative command output. The transport validates correlation and may update elapsed duration, but it does not fabricate `output.append` or `output.replace`. Tool completion and Turn terminal evidence remain authoritative.

Alternative: use Permission callbacks as Tool starts. Rejected because callbacks are control-plane approval requests, can be absent for already-allowed Tools, and do not prove execution.

### 3. Map Bash to Command and all other Tools to Generic Tool

The Adapter maps validated Claude `Bash` input with a command string to `HostCommandExecutionItem`; all other Tools use `HostToolExecutionItem`. Output is normalized from the matching Tool Result, bounded in the Adapter, and attached at completion. Claude's current structured Bash output has stdout/stderr but no reliable exit code, so exit code remains null unless a later proven SDK field exists.

The Adapter owns Host Item IDs, start time, active Tool map, outcome, and exact completion ordering. It closes the current Agent Message and Reasoning segment before starting a Tool, matching existing Pi behavior and native Assistant response boundaries.

### 4. Convert only finite known native patch schemas

A new Claude-owned patch module validates Edit and Write result shapes. It derives path only from native `filePath`, kind from Tool/result semantics (`Edit` update; `Write` create or update), and serializes non-empty `structuredPatch` hunks into deterministic Unified Patch headers and bodies. Hunk counts, prefixes, coordinates, and single-line paths are validated before publication.

The implementation prefers `structuredPatch` because it works outside Git and was the verified Gate source. It does not generically inspect unknown `patch`, `diff`, or `unified_diff` keys and does not reread the modified file. Malformed, empty, failed, cancelled, or unsupported Tool results remain Tool-only.

Alternative: use `gitDiff.patch` or run `git diff`. Rejected because Git is optional, native `gitDiff` is not always present, and workspace-wide state is not attributable to one Tool.

### 5. Finalization closes every active Tool before Turn completion

Normally each matching Tool Result completes its Item and any reliable File Change immediately afterward. If cancellation, native failure, close, or transport termination leaves active Tools, the Adapter completes them with the Turn's cancelled or failed outcome before `turn.completed`. A successful native Turn with unresolved Tools is a protocol failure rather than fabricated success.

Existing Interaction cleanup remains independent: Tool Use ID, permission control Request ID, and Host Interaction ID continue to have separate ownership.

## Risks / Trade-offs

- [SDK message normalization changes] -> Runtime-check every known Tool block and fail closed on broken known correlation while continuing to ignore unrelated future messages.
- [Parallel Tool results carry ambiguous structured output] -> Associate each result by Tool Use ID and only consume per-message `tool_use_result`; reject ambiguous multi-result structured output rather than guessing.
- [Bash has no stable exit code field] -> Publish honest command output with a null exit code.
- [Only live Tools are projected] -> Keep complete history explicitly out of scope and document that reopened Threads retain the current text-only Claude history boundary.
- [Large or binary Tool output] -> Apply the existing Adapter output limit and publish only supported bounded text/image content.

## Migration Plan

1. Add private Claude Tool/patch types and hermetic interpreter tests.
2. Add Claude Session Tool mapping, bounded output, File Change production, and terminal-order tests.
3. Run focused package tests, typecheck, lint/format checks, and strict OpenSpec validation.
4. Run the opt-in real Claude Gate only when credentials/quota are intentionally available; no ordinary check launches Claude.

Rollback removes the private Tool events, patch module, and Claude mapping. The public contract and persisted data remain unchanged.

## Open Questions

- Complete historical Tool and File Change reconstruction remains a separate change because it needs deterministic historical Item identity and broader native-history coverage.
- Multi-result parallel Tool messages should be re-gated if the SDK emits one `tool_use_result` for more than one Tool Result block in production.
