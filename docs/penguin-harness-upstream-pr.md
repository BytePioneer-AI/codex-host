# Upstream PR: Penguin Harness adapter

## Proposed title

`feat: add experimental Penguin Harness adapter`

## Summary

This PR adds an experimental Penguin Harness adapter to CodexHost. Penguin remains the owner of its Agent Loop, Provider credentials, native tools, permissions, and native Sessions. CodexHost provides the adapter boundary, Desktop presentation, model selection at Session creation, event projection, approval routing, and lifecycle reconciliation.

The adapter is based on the CodexHost `v0.4.4` release line. The local validation build is named `0.4.4-penguin-local.1`; this suffix identifies a local compatibility revision and is not an attempt to replace the upstream release version.

## What is Penguin Harness?

[Penguin Harness](https://github.com/Prism-Shadow/penguin-harness) is an open-source, local-first multi-agent application development platform. It runs on a local computer or server and provides the runtime around an Agent: Agent Loop execution, model/provider selection, tools, permissions, native Sessions, traces, skills, and the surrounding Web/Desktop experience. Its focus is broader than a chat client: it can help build, evaluate, optimize, and deploy agent applications, and it includes an agent self-evolution workflow.

In this integration, “Penguin Harness” refers to that native Penguin runtime and its `default_agent` or other user-created agents. CodexHost does not replace Penguin's runtime or move its credentials into CodexHost. It presents a Penguin Agent as another selectable execution Harness inside Codex Desktop.

## Why this adaptation is needed

Penguin is useful as an execution Agent because it can combine external models with local tools, skills, permissions, traces, and its own Session memory. Codex Desktop is useful as the single interface for selecting a Harness, reviewing streamed work, approving tools, and continuing tasks. The adaptation connects these two roles without conflating the model Provider route with the Agent Host layer.

The reason for making this local adapter is that the upstream CodexHost release did not yet include Penguin support. A simple executable detector would only make an entry appear in the UI; it would not make the Agent usable. The adapter is needed to translate Penguin's Projects, Agents, Models, native Sessions, HTTP/SSE events, approvals, cancellation, and terminal lifecycle into CodexHost's `HarnessAdapter` contract. It also gives the upstream project a concrete implementation and regression cases to review rather than a product-specific patch description.

## Why this is needed

Detecting a Penguin executable alone does not provide a usable Harness. Without an adapter, Codex Desktop cannot reliably discover Penguin models, create or resume native Sessions, stream tool events, route approvals, or close a Host turn when the native runtime finishes. The missing lifecycle mapping can leave a completed task displayed as still running and make cancellation fail.

## Scope

The adapter currently provides:

- Penguin CLI discovery and local HTTP/SSE connection;
- reuse of an existing local Penguin Server or startup of an adapter-owned loopback Server;
- one retry after a local Server rotates its `api-token`;
- Project, Agent, model, and Thinking catalog discovery;
- model selection when creating a new native Penguin Session;
- native Session creation and resumption;
- history and usage projection;
- streaming text, reasoning, tool calls, and tool output;
- one-time, session-level, and denied tool approvals;
- Session permission modes and Thinking selection;
- task cancellation;
- fallback completion reconciliation when the terminal event is missed but the native Session is idle;
- immutable event snapshots before events enter the Host queue;
- Renderer registration, localization, icons, Agent selection, and model selection;
- Host Bundle and npm package inclusion.

## Important design boundaries

Penguin owns Provider authentication and model execution. CodexHost does not read, copy, or expose API keys to the Renderer. `Project / Agent` selects the native Session grouping; the Codex workspace is sent as the Session workspace and controls where tools operate.

Penguin fixes the Provider/Model on Session creation. The adapter therefore exposes model selection only for a new Thread and does not pretend to support changing the model inside an existing Session.

The adapter does not modify the official Codex executable or Provider route. It is an Agent Harness integration, not a model proxy.

## Lifecycle fix

Penguin can emit a terminal event after a mutable item has already received streamed updates. Passing the same object reference into the Host event queue caused the Host to observe a polluted start snapshot and reject the final textual completion with:

`Host textual Item completion does not match its append updates`

The adapter now clones every event at the queue boundary. A completion probe also checks the native Session and final history when the expected terminal event is absent. Together these prevent the “tools completed but the Codex chat keeps running” failure mode.

## Known limitations

The following are intentionally not claimed by this PR:

- Fork;
- rollback of the previous turn;
- Penguin Question interaction;
- native File Diff;
- Penguin child-Agent mapping;
- changing Provider/Model inside an already-created Session.

These limitations are reported as unsupported instead of being represented as false success.

## Validation

The local branch passes:

```bash
npm run check
```

The current validation result is 190 TypeScript test files with 1,665 tests passing, plus the complete Rust workspace test suite. An isolated App Server Host test also completed a real Penguin tool call, approval, streamed response, and exactly one `turn/completed` event with empty diagnostics.

The reviewer should additionally verify against the current Penguin API and test at least:

1. a new Session with an explicitly selected model;
2. a pure text turn;
3. a tool turn;
4. an approval-required tool turn;
5. cancellation while a turn is active;
6. resumption of an existing native Session;
7. a native Session that reaches `idle` without the expected terminal event.

## Review request

Please review whether the current CodexHost `HarnessAdapter` contract is the right long-term boundary for Penguin, and whether the event/lifecycle reconciliation should be generalized into shared Host code. The current implementation keeps Penguin-specific API knowledge inside the Penguin adapter and avoids changing other Harness adapters.
