# Harness Command Integration Guide

This guide is the short checklist for adding a Harness-specific command to codexhost.

## 1. Define the command

Choose a stable command ID and descriptor:

```ts
{
  id: "pi.compact",
  invocation: "/compact",
  label: "Compact context",
  argumentMode: "text",
}
```

Use `none` when the command has no argument and `text` when it accepts trailing text.

## 2. Register it in the owning Adapter

Add the descriptor to the Adapter's command catalog. Implement execution in that Adapter and validate:

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

The shared command catalog and Host command RPC should not need command-specific branches. The Renderer should consume the catalog and execute by command ID through the Composer's independent Harness Commands button and popover.

The command button belongs to the active external Harness controls, near the Composer's left-side actions. It MUST remain outside the Codex React-managed Slash command list; the independent popover owns its own focus, keyboard navigation, positioning, and scrolling.

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

## Current examples: Pi, Grok, and Claude commands

```text
Renderer command catalog
  -> Composer Harness Commands button
  -> independent command popover
  -> Host command/execute
  -> owning Adapter
       Pi:     native { type: "compact" }
       Grok:   x.ai/compact_conversation { sessionId, userContext? }
       Claude: dedicated transport
               /compact  context compaction
               /init     generate CLAUDE.md
               /recap    one-line session recap
  -> existing Host Item projection
  -> temporary Turn cleanup unless the command requires persistence
```

Grok maps optional trailing text to native `userContext`. Claude `/compact`
maps it to custom summarization instructions. `/init` and `/recap` take no
arguments. These commands invoke Harness-native operations and must not be
submitted as Host text Turns.

Qwen Code does not expose a Harness command catalog yet; its Adapter omits
`capabilities.commands`.

## Boundaries

- The Adapter owns Harness-specific semantics.
- The Host owns registration checks and routing.
- Shared contracts remain Harness-neutral.
- Renderer code must not parse or execute Harness `SKILL.md` files.
- UI DOM selectors are compatibility details, not command contract requirements.
