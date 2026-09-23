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

Declare a static `HarnessAdapter.commandCatalog`. Reading this metadata must not call `inspect()`, connect to a native service, or open a Session. `session.commands.list()` returns the same built-ins, plus any live native commands described in [Live native catalogs](#live-native-catalogs). Implement execution in the owning Adapter and validate:

- command ID;
- argument shape;
- Session busy state;
- native Harness availability.

Do not add a generic raw-RPC passthrough.

Descriptors may set `kind: "skill"` when the Harness itself reports the entry as a skill; otherwise omit `kind` (treated as a command). Never infer skills from names.

## 3. Add the native translation

Keep native protocol details inside the Adapter and its Transport. Translate native results and events into existing Host semantics.

For commands with visible progress, decide explicitly whether they need:

- a temporary projection Turn;
- existing Item events;
- existing UI projection;
- ordinary history persistence.

## 4. Reuse Host and Renderer routing

Catalog reads never open or resume a Session:

- `codexhost/harness/commands/inspect { harnessId, cwd? }` serves a draft before its Thread exists. Without `cwd` it returns the static Adapter metadata. With `cwd` it returns, in order: the live catalog of a loaded Session of the same Harness and workspace (for example the draft's own prewarmed Session), the workspace's cached live catalog, then the static metadata.
- `codexhost/thread/commands/inspect { threadId }` returns the loaded Session's `session.commands.list()` when that Session is already loaded and reports live entries, and otherwise falls back like the draft read for the Thread's workspace. A listing failure or a read past the Host's one-second inspection deadline also falls back. The Renderer uses it for existing Threads and refreshes it whenever the Composer `#` menu opens.

For Harnesses whose Adapter sets `liveCommandCatalog: true`, inspection results carry `source`: `live` when they include what a native Session reported for the workspace, `static` when they are the Adapter built-ins only. Other Harnesses leave `source` unset.

Every live result is remembered in memory per Harness and workspace (at most 64 workspaces, least recently used first out), so a new draft in a workspace that already had a running Session shows its project commands and skills. The cache never crosses workspaces and never survives a Host restart; the Host never starts a native process to fill it.

A draft's workspace reaches the Host only through Desktop's `thread/start` prewarm. The desktop-control draft bridge publishes that `cwd` per Host (`window.__codexhostDraftWorkspacesV1` and the `codexhost:draft-workspace` event, once when the prewarm starts and again when it settles); the Renderer passes it to the draft read and refreshes the draft's catalog when it changes. A draft with no workspace uses the static catalog.

When the result is `static`, the `#` menu adds a hint under the commands that the project's commands and skills load after a message is sent. The hint shows on a bare `#` even when no command is listed, and is dropped once the query matches nothing.

The Composer `#` menu is the single command surface; it has no Harness-specific catalog branches. The command (⌘) button is its discoverable entry: hovering explains the `#` trigger, and clicking types `#` at the caret (spaced from a preceding word) to open the menu. The button holds the Harness command catalog the menu reads.

- Selecting `/compact` or an `argumentMode: "none"` command executes it directly through `codexhost/thread/command/execute` with no text arguments, leaving the current draft and attachments untouched, even when the Harness supports optional compaction instructions. Direct commands execute only when a Thread exists; otherwise they are disabled with an explanation.
- Selecting another text command inserts a native Composer mention chip in place of `#query` (`subagent://codexhost-command.<name>`), because literal `/command` text opens Desktop's own `/` menu. When Desktop's Composer controller is unavailable, the invocation is prefixed in the editor instead. On External Thread `turn/start` and `turn/steer` the Host restores the first chip to a leading `/command arguments` before the same catalog matching and command execution; other command chips are dropped. Only separators adjacent to removed chips are normalized; internal argument spaces, tabs and indentation are preserved. Steering retains the existing stop-then-start sequence, duplicate-message receipts and response-before-event ordering. Cancellation during command discovery prevents the replacement command from starting.
- When every listed command is disabled and nothing else matches, the menu stays open to show why; Enter is then left to the Composer.
- The `#` menu groups entries into Commands, Skills (descriptors with `kind: "skill"`) and delegation Agents.

The command button belongs to the active external Harness controls, near the Composer's left-side actions. It stays visible and enabled before a Thread exists and whatever the catalog or execution state, because the `#` menu also lists delegation targets. Switching to Codex hides it. The `#` menu MUST remain outside the Codex React-managed Slash command list; it owns its own focus, keyboard navigation, positioning, and scrolling.

For typed submission, the Host first checks for a leading slash-command token (ignoring leading whitespace). Only command candidates have trailing whitespace removed before catalog matching; ordinary prompts retain their original text and skip command catalog inspection. Unknown slash commands are rejected, except while a `liveCommandCatalog` Harness's Session still reports only its built-ins (its native process has not started, typically a Thread's first message): the Composer may already list the workspace's live commands from another Session or the cache, so the text goes to the Harness as an ordinary prompt and the native Harness resolves it, as live commands always execute. Commonly excluded commands stay rejected.

Only add Renderer-specific code when the command needs a new presentation or interaction.

## Live native catalogs

When a running native Session reports its own commands and skills, the Adapter appends them to its built-ins with `LiveHarnessCommandCatalog` / `mergeLiveHarnessCommands` from `@codexhost/harness-adapter`:

- built-ins keep their dedicated handling and win on name clashes;
- live entries get a namespaced id (`<harness>.slash.<name>`), `argumentMode: "text"` so the Composer claims them for the user to complete, and `kind` from native metadata;
- names containing whitespace are skipped;
- execution sends the native slash text (`/name arguments`) as an ordinary prompt Turn;
- the listing never starts a native process; before the Session's process starts only built-ins are reported.

Live commands are filtered by a blocklist, never an allowlist. `COMMON_EXCLUDED_LIVE_COMMANDS` in `@codexhost/harness-adapter` lists native commands that replace or reset the Session behind the Host's history, change Desktop-owned configuration (Model, effort, permissions), change trust or approval policy, need a native login or terminal UI, manage plugins or MCP, or start work that outlives the Turn (loops, schedules, background jobs, goals); names starting with `__` or `hooks-` are excluded too. The common list never hides skills, so a user skill is not lost to a name clash; each Adapter adds its own names, which apply to skills as well. Curated Adapter built-ins are not filtered. Because the Host only runs catalog commands, an excluded command is also rejected when typed.

| Harness | Native source | Skill signal | Adapter exclusions beyond the common list |
| --- | --- | --- | --- |
| Claude Code | SDK `initializationResult().commands`, `commands_changed` | `init` system message `skills` | account and usage settings, `doctor`, `ultrareview`, removed or renamed commands, workflow entry points |
| Pi | RPC `get_commands` on each listing | `source: "skill"` | pi-subagents run management and profile rewriting, Host-internal `subagents-inspect-rpc` |
| Grok | ACP `available_commands_update` | `_meta.path` is a `SKILL.md`, or `_meta.qualifiedName` | — |
| Kiro CLI | ACP `available_commands_update` | `_meta.kiro.type: "skill"` | — |
| OMP | RPC `available_commands_update` event | `source: "skill"` | every `source: "builtin"` entry (terminal UI commands) |
| CodeBuddy | ACP `available_commands_update` | `_meta.type: "skill"` | its own reviewed list |
| Cursor CLI | ACP push | none (common list applies to every entry) | `update-cli-config` |
| Qoder, Hermes | SDK or ACP push | none (common list applies to every entry) | — |

WorkBuddy, DeepSeek Harness and OpenCode deliberately keep static catalogs. Antigravity CLI has no native listing interface.

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

## Current examples: Pi, Grok, Claude, and DeepSeek built-in commands

```text
Adapter static commandCatalog (no native request or Session)
  -> Host harness/commands/inspect
  -> Composer `#` menu (the command button types `#`)
  -> /compact or argumentMode none: fixed Host command/execute (no arguments)
     other argumentMode text: command chip, restored to `/command` on turn/start
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

Pi manual `/compact` and automatic compaction have no Host wall-clock deadline: native `compaction_end` determines their outcome. Pending Prompt and Compact response timeouts pause while compaction is active and resume afterward. Startup, other RPC responses, cancellation, and process cleanup retain their existing bounds.

Grok maps optional trailing text to native `userContext`. Claude `/compact`
maps it to custom summarization instructions. `/init` and `/recap` take no
arguments. These commands invoke Harness-native operations and must not be
submitted as Host text Turns.

DeepSeek declares exactly `/compact`, `/dsh-goal`, and `/plan` in its static Adapter catalog, for both new and existing Threads. Neither catalog display nor command admission queries native `commands/list`. Execution retains ID, argument, busy-state, cancellation, and native-result validation; an unsupported native deployment reports its execution error rather than being probed beforehand. Native `feedback`, `permission`, `export`, the Client-side `/model`, and unknown commands are not exposed through this surface.

DeepSeek has been tested with `0.1.2-rc.1`, `0.1.5-rc.1` and `0.1.5-rc.2`; other SemVer versions may attempt native protocol validation. The Adapter sends `images: []` with `commands/execute` for the `0.1.2` family's V0 profile, or `submittedAttachments: []` for the V3 profile; this version-specific translation does not add attachment input or native descriptor discovery to the public command surface.

OpenCode exposes only the fixed `/compact` command, implemented through native Session summarization. Dynamic native command discovery and execution are not part of its Host integration.

The public `/dsh-goal` invocation avoids Codex Desktop's built-in `/goal` command and maps only inside the Adapter to native DSH `/goal`. `/dsh-goal` and `/plan` accept text arguments only. DSH remains the owner of goal and plan state and any model-visible follow-up.

## Boundaries

- The Adapter owns Harness-specific semantics.
- The Host owns registration checks and routing.
- Shared contracts remain Harness-neutral.
- Renderer code must not parse or execute Harness `SKILL.md` files.
- UI DOM selectors are compatibility details, not command contract requirements.
