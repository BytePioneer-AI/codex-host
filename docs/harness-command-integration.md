# Harness Command Integration Guide

This guide is the short checklist for adding a Harness-specific command to codexhost.

## 1. Define the command

Choose a stable command ID and descriptor:

```ts
{
  id: "dsh.plan",
  invocation: "/plan",
  label: "Plan mode",
  argumentMode: "text",
}
```

Use `none` when the command has no argument and `text` when it accepts trailing text.

## 2. Register it in the owning Adapter

Declare a static `HarnessAdapter.commandCatalog`. Reading this metadata must not call `inspect()`, connect to a native service, or open a Session. Keep `session.commands.list()` consistent with this catalog for existing execution clients. Implement execution in the owning Adapter and validate:

- command ID;
- argument shape;
- Session busy state;
- native Harness availability.

Do not add a generic raw-RPC passthrough.

## 3. Add the native translation

Keep native protocol details inside the Adapter and its Transport. Translate native results and events into existing Host semantics.

For commands with visible progress, decide explicitly whether they need:

- a temporary projection Turn;
- existing Item events;
- existing UI projection;
- ordinary history persistence.

## 4. Reuse Host and Renderer routing

The Renderer reads static metadata via `codexhost/harness/commands/inspect { harnessId }`, through the target Host and public Adapter contract. No Thread or Native Session is needed, and there is no native-discovery fallback. The legacy Thread catalog RPC also reads Adapter metadata without opening or resuming a Session. The independent Composer popover has no Harness-specific catalog branches. Selecting `/compact` always executes directly with no text arguments, leaving the current draft and attachments untouched, even when the Harness supports optional compaction instructions. Other text commands prefix their invocation in the current editor, including before the first Turn, preserving the draft and attachments for ordinary submission. Direct commands (`/compact` and argument-free commands) execute only when a Thread exists; otherwise their menu items are disabled with an explanation, while the menu and other text commands remain available. Manually submitted `/compact` text retains the Adapter's existing argument support.

The command button belongs to the active external Harness controls, near the Composer's left-side actions. It remains visible before a Thread exists and while the command catalog is empty or unavailable; in those states it is disabled with a localized availability hint. Only command execution requires a Thread; catalog inspection does not. Switching to Codex hides the external Harness command button and closes its popover. It MUST remain outside the Codex React-managed Slash command list; the independent popover owns its own focus, keyboard navigation, positioning, and scrolling.

For typed submission, the Host first checks for a leading slash-command token (ignoring leading whitespace). Only command candidates have trailing whitespace removed before catalog matching; ordinary prompts retain their original text and skip command catalog inspection. Unknown slash commands are rejected.

Only add Renderer-specific code when the command needs a new presentation or interaction.

## 5. Add focused tests

At minimum, cover:

- command appears in the owning Adapter catalog;
- unknown command is rejected;
- invalid arguments are rejected;
- busy Session is rejected;
- native operation is called with the expected payload;
- success, failure, and cancellation are projected correctly;
- temporary command Turns are not persisted when appropriate;
- the command is isolated from other Harness Threads.

## 6. Validate locally

Run the focused tests for the changed Adapter and Host packages, then run:

```bash
npm run build:typescript
git diff --check
```

For native RPC changes, also verify the request and event sequence against the real Harness when available.

## Current examples: Pi, Grok, Claude, and DeepSeek commands

```text
Adapter static commandCatalog (no native request or Session)
  -> Host harness/commands/inspect
  -> Composer Harness Commands button
  -> independent command popover
  -> /compact or argumentMode none: fixed Host command/execute (no arguments)
     other argumentMode text: prefix the Composer, then ordinary turn/start
  -> current Host catalog validation
  -> owning Adapter
       Pi:     native { type: "compact" }
       Grok:   x.ai/compact_conversation { sessionId, userContext? }
       Claude: dedicated transport
               /compact  context compaction
               /init     generate CLAUDE.md
               /recap    one-line session recap
       DeepSeek: fixed Adapter catalog
                 /compact
                 /dsh-goal [<objective>|clear|edit <objective>|pause|resume]
                   -> native /goal
                 /plan [off|message]
                 -> commands/execute { agentId, line }
  -> existing Host Item projection
  -> temporary Turn cleanup unless the command requires persistence
```

Grok maps optional trailing text to native `userContext`. Claude `/compact`
maps it to custom summarization instructions. `/init` and `/recap` take no
arguments. These commands invoke Harness-native operations and must not be
submitted as Host text Turns.

DeepSeek declares exactly `/compact`, `/dsh-goal`, and `/plan` in its static Adapter catalog, for both new and existing Threads. Neither catalog display nor command admission queries native `commands/list`. Execution retains ID, argument, busy-state, cancellation, and native-result validation; an unsupported native deployment reports its execution error rather than being probed beforehand. Native `feedback`, `permission`, `export`, the Client-side `/model`, and unknown commands are not exposed through this surface.

OpenCode exposes only the fixed `/compact` command, implemented through native Session summarization. Dynamic native command discovery and execution are not part of its Host integration.

The public `/dsh-goal` invocation avoids Codex Desktop's built-in `/goal` command and maps only inside the Adapter to native DSH `/goal`. `/dsh-goal` and `/plan` accept text arguments only. DSH remains the owner of goal and plan state and any model-visible follow-up.

## Boundaries

- The Adapter owns Harness-specific semantics.
- The Host owns registration checks and routing.
- Shared contracts remain Harness-neutral.
- Renderer code must not parse or execute Harness `SKILL.md` files.
- UI DOM selectors are compatibility details, not command contract requirements.
