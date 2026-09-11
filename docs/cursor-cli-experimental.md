# Experimental Cursor CLI Harness

Cursor can execute native CLI sessions through codexhost's public Harness plugin
contract. This package remains experimental. The preinstalled distribution
connects it to the Desktop Agent
Picker, configuration preferences, sidebar ownership and Connections page. Live
Desktop adoption remains separate from packaging and Host protocol validation.

## Transport choice

The adapter launches `cursor-agent acp` and uses the official ACP SDK over stdio.
This preserves Cursor's existing CLI authentication, native tools and interactive
approval requests. Cursor-specific translation remains inside `adapter-cursor-cli`.
Host Runtime, Protocol Core and Renderer do not import the adapter.

The [TypeScript SDK](https://cursor.com/docs/sdk/typescript) is suitable for
headless runs, but its local execution model does not offer the same interactive
approval round trip. The [SDK Bridge](https://cursor.com/docs/sdk/bridge) embeds
that SDK for other languages and would add another server to this TypeScript
integration. [CLI ACP](https://cursor.com/docs/cli/acp) is the selected interface.

## Implemented boundary

- Native create, text prompt, streaming text/reasoning, tool progress and cancellation.
- Dynamic native model catalog. Full bracketed model variants are encoded into
  transport-safe Host refs without losing native model parameters.
- Native Agent, Plan and Ask configuration, confirmed by the ACP response before
  changing Host state. These are execution modes, not fabricated approval levels.
- Native tool approvals and Cursor's blocking question/plan extensions, with
  exact interaction correlation, response validation and cancellation cleanup.
- Session resume and read-only snapshots, with strict native turn identity checks.
- Negative discovery caching and bounded startup/configuration/close. There is no
  polling timer, automatic provider substitution or Codex fallback.
- Direct Windows bundle invocation avoids leaving a PowerShell/cmd launcher owner
  in between Host and the ACP process. Configuration may select an executable via
  `CODEXHOST_CURSOR_COMMAND`. User authentication is never copied into the plugin.

## Experimental history gate

The tested Cursor CLI `2026.09.08-6caf4ff` emits no persistent user-turn ID in either
ACP prompt completion or replay. The prototype reads only user-turn identity and
prompt text from its native `~/.cursor/acp-sessions/<id>/store.db`, using a read-only
SQLite connection. A small bounded decoder follows the observed native root/turn
references. This is an undocumented native format, not a supported Cursor API.

The snapshot body comes from a fresh native ACP `session/load`. It is accepted only
when session, workspace, turn count, order and exact prompt text match native
history. A successful live turn must introduce exactly one native user-turn ID.
Missing/ambiguous history is an error; generated UUIDs, array positions and text
hashes are never used as native turn keys. The adapter keeps no shadow transcript.

The real Windows restart smoke demonstrates that completed turn IDs remain equal
after the adapter process is replaced, and a follow-up retains earlier context.
This does not establish compatibility with other Cursor versions, compacted
histories, externally modified sessions or every tool payload.

Cursor can cancel before persisting a native turn. In that case the cancelled
terminal intentionally has no `nativeTurnRef`. ACP history also omits historical
stop reasons, so snapshot outcomes are `unknown`. Do not infer a historical success
from the presence of assistant text. Cancellation persistence needs further native
contract investigation before release acceptance.

## Current limitations

- The Desktop Agent Picker is still based on a static Harness list. This integration
  adds Cursor explicitly and uses the shared plugin carrier. Its independent model
  and mode preferences do not inherit another Harness's Thinking selection.
- Fork, rollback, independent thinking selection, usage/account reporting, native
  session import, unattended full access and internal subagent transcript browsing are not
  advertised. Image/audio prompt inputs are outside the current Host text contract.
- Tool changes are visible as tool output; complete native file-diff projection
  and every Cursor notification extension are not implemented.
- Model inspection opens one empty native ACP session per cache refresh because
  the catalog is returned by `session/new`. It submits no model prompt. Both
  successful and failed inspection results are cached for five minutes on demand.
- The native history format and operating-system authentication behavior require
  platform/version acceptance before formal product support is claimed.

## Build a separate candidate

From the repository root, after `cursor-agent login` has completed in the user's
own terminal:

```powershell
npm ci --ignore-scripts
npm run typecheck
npx vitest run --config tests/vitest.config.js packages/adapters/cursor-cli/test
node tools/build-cursor-plugin.mjs <new-absolute-candidate-directory>
```

The builder refuses an existing output directory. It creates a relocatable plugin
bundle and an `enabled.json` for that candidate root. It does not install, modify
user configuration, restart Desktop or change the preinstalled plugin list.

## Reproducible probes

Use a dedicated empty smoke workspace: these commands execute real Cursor turns
using the user's native account. Receipts contain only synthetic test identities,
responses and aggregate results; no raw credentials or native store copies.

```powershell
# Real multi-turn execution, then a NEW process that resumes the same session.
node tools/cursor-harness-smoke.mjs <smoke-workspace>
node tools/cursor-harness-smoke.mjs <smoke-workspace> --resume

# Load the packaged plugin through the actual Host plugin loader, deny a native
# harmless shell request, and cancel a streaming turn.
node tools/cursor-controls-smoke.mjs <candidate-directory> <smoke-workspace>

# Actual AppServerHost JSON-RPC route with isolated mapping/account state.
# Only the unused official Codex child is synthetic; Cursor execution is real.
node tools/cursor-host-protocol-smoke.mjs <candidate-directory> <smoke-workspace> <new-host-state-directory>
```

Passing these probes establishes the tested Host/adapter boundary. Do not run
`npm start` as a validation shortcut: on Windows/macOS it stops the current Desktop
processes.

## Native Task cards and replay identity

Native Task pending/running/terminal events become Host collaboration cards and
read-only child Threads. The `cursor/task` extension confirms final native model
metadata. Current ACP does not expose the child's internal message/tool stream;
the child view contains its real prompt and the full text result ACP provides,
including after reconnect. The 2,000-character result limit applies only to card
summaries, not child view content. Native pending and in-progress Task notifications
remain distinct pending/running card states. Internal steps are not synthesized.
A successful background launch is not child completion; observation ends as
interrupted if parent exit leaves completion unconfirmed.

Cursor rewrites live tool-call IDs to `replay-N-M` during `session/load`. Child
inspection therefore uses a parent-scoped native invocation address: verified
Turn position, Task position and input fingerprint. This address is not a native
user-Turn ID or a fabricated child Session. The native Turn sequence is checked
before/after history reads, and changed inputs or missing Tasks fail closed.

## macOS SSH and Remote Control

Direct SSH startup can report a locked login keychain despite native GUI login.
Managed remote plugin construction selects the [native Aqua broker](native-aqua-broker.md)
and preserves that login session:

```sh
codexhost broker install --harness cursor-cli
codexhost broker status --harness cursor-cli
```

There is no direct SSH/native-provider fallback if the broker is unavailable.
Neither credentials nor native stores are copied into Host state.

The implementation was packaged on Windows/macOS in a combined 0.6.2 candidate
before this independent Cursor PR. Native Task lifecycle, Plan/Agent switching,
and the same child handle after process/Host reconnect were verified. The user
also verified local Desktop subagents, Windows-to-Mac remote sessions, and
Mac-to-Windows Remote Control. These deployed-candidate/user checks are distinct
from automated tests of this branch, and do not establish compatibility with
unobserved future versions of Cursor's private history format.
