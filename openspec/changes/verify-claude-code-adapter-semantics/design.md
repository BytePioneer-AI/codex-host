## Context

codexhost has a proven Pi text Session and is adding Tool/Cancel Host semantics in a separate change. The current HarnessAdapter design names Claude Code as the second Harness, but its Claude candidates were written against older SDK evidence and have not been verified against the current user installation.

The local baseline for this change is Claude Code `2.1.220` and official `@anthropic-ai/claude-agent-sdk` `0.3.220`; the SDK manifest declares that same Claude Code version. Initial ignored local experiments already established that the SDK can initialize without persisting an empty Session, preserve caller-assigned Session/User UUIDs, execute multiple Turns in one Query, resume and fork native history, surface Tool/Question callbacks, expose native structured patches, interrupt a running Tool, and continue afterward. They also exposed important edge behavior: clearing `settingSources` removes the local OAuth context, `result.subtype === "success"` can still carry `is_error === true`, Bash did not emit Tool Progress in the tested run, and Fork remaps message UUIDs.

Paseo is an AGPL reference implementation, not a source dependency. Its Claude provider demonstrates a long-lived SDK Query, explicit process ownership, preallocated UUIDs, and permission routing, but also owns a large persistent Timeline and contains file-change inference paths that conflict with codexhost's single-source-of-truth and reliable-native-Patch rules.

This change is a technical Gate. It must not race the Tool/Cancel change by editing shared production modules, and it must not turn Claude Code into a product-visible Agent.

## Goals / Non-Goals

**Goals:**

- Establish the official Claude Agent SDK plus a user-installed Claude Code executable as the primary candidate integration path.
- Build reproducible inspect, isolated, and explicitly live scenarios for Session, Turn, Tool, Interaction, Cancel, history, resume, Fork, and process behavior.
- Preserve raw native evidence locally while committing only deterministic tests and reviewed sanitized summaries.
- Produce concrete contract input for a later minimal `ClaudeCodeAdapter` without changing HarnessAdapter in this change.
- Identify unsupported, optional, unstable, policy-sensitive, or still-unverified behavior explicitly.

**Non-Goals:**

- No production `ClaudeCodeAdapter`, Renderer Agent option, Host routing, Mapping Store record, one-class Thread projection, or release package.
- No modification of the in-progress Tool/Cancel contract, PiAdapter, Protocol Core, or Host Runtime.
- No parsing of TUI text and no direct use of CLI `stream-json` as the preferred production seam when the official SDK exposes the required structured operation.
- No scanning or import of the user's existing Claude Sessions.
- No persistence of Prompt, Transcript, Tool output, credentials, account details, complete native IDs, or local absolute paths in Git.
- No copying of Paseo code or adoption of its persisted normalized Timeline.

## Decisions

### 1. Use the official Agent SDK as the primary candidate seam

The probe uses exact development dependencies for the current official Agent SDK and required peer packages. It passes the user-installed Claude Code executable through `pathToClaudeCodeExecutable`, so Native Mode continues to use the user's binary, authentication, Provider, settings, and native Session store rather than silently substituting a bundled Harness.

The SDK provides typed `query()`, `startup()`, `Query.interrupt()`, `canUseTool`, `supportedCommands()`, `supportedModels()`, `getSessionMessages()`, `forkSession()`, `resume`, `sessionId`, and process-spawn customization. Raw CLI `--input-format=stream-json --output-format=stream-json` remains a differential and diagnostic source only.

Alternative: directly implement the undocumented control-request protocol. Rejected because it duplicates the official SDK's request correlation, callback routing, process compatibility, and evolving message normalization.

Alternative: reuse Paseo's Claude provider. Rejected because of AGPL boundaries, a much wider product model, Timeline persistence, and semantics that do not match codexhost.

### 2. Separate deterministic checks from real native behavior

The Gate has three profiles:

1. Hermetic tests validate command selection, summary schemas, redaction, unknown-event tolerance, result classification, Patch conversion, and Gate verdicts without launching Claude.
2. Inspect/isolated scenarios query the installed version/auth shape, run SDK initialization or `startup()` in temporary cwd, enumerate catalogs structurally, and prove no empty Session is persisted without a Prompt. They must not call a model.
3. Live scenarios are explicit and use small synthetic prompts, bounded budgets, temporary cwd, caller-generated UUIDs, controlled Tool sets, and local ignored Capture. They validate text, multi-Turn, Tool, Question, Cancel, resume, and Fork.

Ordinary checks run only the Hermetic profile. Inspect and live scenarios require explicit commands; live execution must state that it can consume network/model quota.

### 3. Treat local settings and authentication as native capability, not probe configuration

The probe must load the `user` setting source for Native Mode authentication. A local experiment showed `settingSources: []` produced `authentication_failed` while `settingSources: ["user"]` succeeded with the same binary and OAuth login. Project/local settings are included only in scenarios that explicitly test Native Mode resource inheritance.

`inspect()`-equivalent checks may call `claude auth status --json`, but committed summaries only contain booleans and enum-like method/provider categories. Email, organization, tokens, headers, account IDs, subscription details, and raw settings never enter committed evidence.

The future Adapter must identify itself through the SDK client-app environment variable. Omitting identification to influence entitlement or billing behavior is not an accepted compatibility mechanism.

### 4. Preallocate identity, publish it only after native confirmation

The Host can generate a UUID and pass it as SDK `sessionId` with the first accepted Turn. The Probe must verify every native message uses that ID and that the ID appears in native Session APIs after the Turn. A warm `startup()` may occur before a Prompt only if closing it leaves no Session record.

Caller-generated User Message UUIDs are Native Turn Ref candidates because the current SDK accepts them and `getSessionMessages()` returns them unchanged and ordered across multi-Turn execution and resume. The Probe still treats native confirmation as required; assigning a UUID alone does not prove a Turn was accepted or persisted.

### 5. Derive Turn outcome from the complete result, not one discriminant

A Claude Host Turn begins only after the Adapter accepts the command and owns its callback/state associations. SDK initialization and Session identity do not imply Turn acceptance.

The native terminal classifier must inspect at least `result.subtype`, `is_error`, `terminal_reason`, Assistant error enums, and explicit cancellation state. `subtype: "success"` is not sufficient: it can coexist with `is_error: true` and an API failure. `terminal_reason: "completed"` with `is_error: false` is success; an accepted Host cancel that converges through `aborted_streaming` or `aborted_tools` is a cancelled candidate; other error terminals are failed unless a later Adapter design has stronger evidence.

Unknown native messages are recorded structurally and ignored unless they break required lifecycle correlation. The current CLI emitted `command_lifecycle` records not present in the SDK's exported `SDKMessage` union, so exhaustive TypeScript handling cannot replace runtime validation and forward-compatible unknown handling.

### 6. Use native Tool results and keep Progress optional

Tool identity comes from native Tool Use ID. Assistant `tool_use` starts the logical Tool; partial input events may update its input; a matching Tool Result completes it. `tool_progress` is optional because the tested long Bash run emitted none even after six seconds.

For Edit/Write, `SDKUserMessage.tool_use_result` is the evidence source. Current Edit output exposes `originalFile`, `structuredPatch`, and sometimes `gitDiff.patch`. A File Change may be produced from a successful native `structuredPatch` or native patch string. If Codex projection requires Unified Patch, the Adapter may deterministically serialize native structured hunks, but it must not infer changes from `old_string/new_string`, reread the file, inspect Git, or compare before/after filesystem snapshots.

Unknown Tools remain Generic Tool. A Tool without reliable native change data remains only a Tool.

### 7. Split Question and Approval even though both use `canUseTool`

`canUseTool` carries Tool Use ID, control Request ID, AbortSignal, optional permission suggestions, and human-facing metadata. Ordinary Tool permission callbacks are Approval candidates. `AskUserQuestion` is a Question because its schema contains questions/options and expects answers keyed by complete question text.

The Adapter must maintain separate Host Interaction identity while preserving the native Tool Use ID for the Tool Item. Callback cancellation, duplicate response, unknown response, allow-once, deny, and supported persistent permission updates are separate scenarios. Native `PermissionUpdate.destination` values must not automatically become Host actions; only actions the product can faithfully execute may be offered.

### 8. Interrupt must converge native execution before Host completion

`Query.interrupt()` acceptance is not alone a Turn terminal. The Probe waits for the native result and checks owned Tool processes/side effects. The current running-Bash experiment produced `error_during_execution`, `is_error: true`, `terminal_reason: "aborted_tools"`, terminated the script process, avoided the completion side effect, and allowed the next Turn in the same Query and Session.

The later Adapter must close active Tool and Interaction lifecycles before the unique Turn terminal. Query close remains a separate bounded Session operation. A custom `spawnClaudeCodeProcess` hook is required in product code so codexhost can supervise the Claude process tree; the Gate records direct and descendant process cleanup where safely observable.

### 9. Use official history and Fork APIs without creating a second Transcript

`getSessionMessages()` is the primary structured history candidate. Resume uses `options.resume`. Exact context Fork uses `forkSession(sessionId, { upToMessageId })`, where the checkpoint is a source Assistant UUID. The current SDK creates a new Session, leaves the source unchanged, truncates context at the selected message, and remaps all copied message UUIDs.

The source Host Turn's Native Checkpoint therefore cannot serve as the derived Session's Native Turn Ref. The future history mapper must establish identities from each Session's own messages. File rewind is explicitly excluded from codexhost Fork even though the SDK exposes `rewindFiles()`.

### 10. Keep real evidence local and conclusions reviewable

Raw JSONL, Session files, prompts, model text, complete IDs, account data, local paths, Tool output, stderr, and live reports remain under `.codexhost/claude-code-probe/`. Committed Fixtures use fixed synthetic values generated without reading local evidence. A tracked Chinese investigation record cites official package declarations, local command categories, sanitized scenario results, and Paseo reference paths without copying source.

The Gate verdict is `PASS`, `FAIL`, or `BLOCKED` per scenario plus an overall recommendation. Missing installation/auth/network produces BLOCKED. A proven lifecycle or safety invariant failure produces FAIL. Optional Progress, unified patch strings, persistent permission actions, and catalogs are capability results rather than automatic failure unless required by the later slice.

### 11. Keep legal, distribution, and billing decisions outside the technical verdict

The npm packages state that use is subject to Anthropic legal agreements. Paseo's documentation also warns that third-party Agent SDK use can have programmatic-usage billing rules, but this change cannot treat Paseo as the policy authority. The report records this as an unresolved release dependency and links the official package/legal references. It does not claim subscription entitlement, bundle redistribution rights, or billing behavior.

## Risks / Trade-offs

- [SDK and CLI types evolve faster than codexhost] -> Pin the development probe version for reproducibility, feature-detect behavior, tolerate unknown messages, and avoid runtime version whitelists.
- [Live tests consume quota and write native history] -> Require explicit live commands, bounded prompts/budgets, synthetic cwd, caller UUIDs, and local ignored output.
- [User settings are required for OAuth but can load custom behavior] -> Separate inspect from live profiles, constrain Tool sets, use temporary cwd, and record exactly which setting sources each scenario loads.
- [The SDK may clean only the direct child while Tools create descendants] -> Use process-spawn injection and platform process supervision in the future Adapter; Gate running Tool cancellation and bounded close explicitly.
- [Native structured patches differ from Pi Unified Patch] -> Keep Host File Change semantic and define deterministic conversion in the concrete Adapter; do not weaken the reliable-native-data rule.
- [Paseo offers useful behavior but carries incompatible design and license obligations] -> Cite behavior and independently implement; do not copy code or persisted Timeline semantics.
- [Official web documentation is unavailable in the current environment] -> Use exact official npm package declarations and local executable behavior as primary evidence; mark policy claims unresolved rather than relying on secondary prose.
- [Parallel Tool/Cancel work changes the shared contract] -> Do not edit shared modules in this change; compare findings only after the Tool/Cancel change lands.

## Migration Plan

1. Add Gate-only dependencies, tooling, Hermetic tests, ignored local output, and explicit inspect/live commands.
2. Reproduce the sanitized local scenarios and write the tracked investigation record.
3. Validate the OpenSpec change and normal repository checks; audit that raw/native evidence and the ignored Paseo reference are not tracked.
4. Feed only confirmed cross-Harness semantic differences into the later `implement-claude-code-contract-slice` after Tool/Cancel lands.
5. Remove the Gate-only SDK dependency if the later production Adapter chooses a different dependency owner; no runtime migration is required because this change adds no product path.

## Open Questions

- Does the current SDK expose a stable Session-idle signal in all normal, failed, cancelled, and no-Agent-Loop commands, or must Result remain the sole Turn terminal input?
- Which `PermissionUpdate` destinations can codexhost honestly expose as allow-for-session or persistent actions without editing native configuration incorrectly?
- Is deterministic serialization of native `structuredPatch` sufficient for every Codex Diff shape, including multiple files and CRLF?
- Which native Assistant UUID should anchor Turns that produce retries, multiple Assistant messages, compaction, or no model call?
- How should the later Adapter classify `subtype: "success"` plus `is_error: true` across all Assistant error enums?
- Does SDK process close reliably terminate MCP and Tool descendants on Windows and macOS, or must platform supervision own the full tree?
- What are the authoritative current Anthropic rules for third-party OAuth, programmatic usage, and redistribution of the SDK/CLI binaries?
