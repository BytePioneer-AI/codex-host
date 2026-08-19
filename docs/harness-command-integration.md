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

The shared command catalog and Host command RPC should not need command-specific branches. The Renderer should consume the catalog and execute by command ID.

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

## Current example: Pi `/compact`

```text
Renderer command catalog
  -> Host command/execute
  -> Pi Adapter
  -> Pi native { type: "compact" }
  -> compaction_start / compaction_end
  -> standard contextCompaction projection
  -> temporary Turn cleanup
```

`/compact` is a command because it invokes Pi's native operation. It must not be sent as a normal Pi Prompt.

## Boundaries

- The Adapter owns Harness-specific semantics.
- The Host owns registration checks and routing.
- Shared contracts remain Harness-neutral.
- Renderer code must not parse or execute Harness `SKILL.md` files.
- UI DOM selectors are compatibility details, not command contract requirements.
