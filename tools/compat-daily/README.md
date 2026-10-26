# Compat daily

Compares the public macOS ChatGPT/Codex Desktop Sparkle appcast to Renderer voice pins. It does not download ChatGPT.app. Sparkle is not a Windows MSIX release feed. A separate daily Windows job checks bounded ASAR metadata, registered/portable MSIX discovery, platform profile selection and Controller bootstrap against fixtures. It does not claim to monitor the latest Windows Store release or verify a live voice call.

```bash
npm run compat:daily:test
npm run compat:daily
```

GitHub: `.github/workflows/compat-daily.yml` (daily 07:17 UTC, `workflow_dispatch`, and path-filtered push/PR). macOS pin drift opens or comments `compat-broken` issues on this repository.

The local command prints JSON containing `latest`, `pins` and `findings`. It exits
with status 1 when macOS Sparkle latest is numerically newer than either surface's
pin. Equal or older feed versions produce no drift findings. Version comparison
uses three numeric components; malformed versions are operational errors. This
release alert does not evaluate every retained profile or change runtime eligibility.
Fetch, parse and pin-loading errors also fail the command, printing JSON with
`error` and an empty `findings` array plus the diagnostic on stderr. Successful
reports retain `latest`, `pins` and `findings`. Running locally does not create issues.
The workflow creates or comments on issues only on non-PR runs of the repository's
default branch, and skips all issue updates for operational errors. Reports include
the checked commit and ref. Other branches still run checks without publishing issue
status. A separate recovery step adds one deduplicated bot comment when a
voice pin matches an open issue’s tracked Desktop target or Sparkle latest. It
leaves the issue open for live acceptance and reports newer drift separately.
No command here updates pins or enables a Desktop build.

## Audit and re-pin after an upstream sync

Use the [fork upstream-sync runbook](../../docs/operations/fork-versioning.md#preserve-live-voice-when-syncing-upstream)
for backup, merge authorization, fork patch preservation and origin-only pushes.
Keep this tool, its npm scripts and the workflow when resolving upstream changes.

1. Run `npm run compat:daily` on the candidate source tree. Record the current
   Work and Chat pins separately from the latest appcast version/build. The
   report reads the working tree, which can differ from committed fork `main`.
2. Inspect only the needed assets from the exact Desktop build being qualified.
   Audit native exports, call ownership, lifecycle and CSP against the
   [Live Voice contract](../../docs/operations/cpa-live-voice-desktop-hook.md).
   An upstream merge, an appcast version match or a transport-only probe does
   not establish microphone/conversation acceptance.
3. Update only the qualified surface's version and exact asset/export mappings,
   along with its guards, focused regression coverage and qualification notes.
   Work pins live in `packages/renderer-extension/src/renderer-client-owned-voice.ts`;
   the optional overlay pin is read from `renderer-voice-start-capability.ts` in
   the same directory. Chat profiles/start assets live in `renderer-native-chat-voice-assets.ts`;
   the parser uses Work version/initial pins if separate Chat constants are absent.
   Preserve independent Chat pins when Work advances. The 26.1016.61520 Chat
   binding maps RouteScope ownership and the inner ComposerScope; see the [native Instant Connect evidence](../../docs/operations/cpa-live-voice-desktop-hook.md#existing-and-new-chatgpt-conversations-native-instant-connect).
   Keep live microphone/audio acceptance separate from a matching pin.
4. Run `npm run compat:daily:test`, the behavior checks selected by the runbook,
   and `npm run compat:daily` again after any pin changes. Record remaining drift
   explicitly. A matching pin only clears version drift; it does not prove the
   native bindings or voice behavior work.

## Windows MSIX diagnosis

Run `codexhost inspect --json` on the Windows host. `desktop.version` comes from
bounded `app.asar/package.json` product metadata; `desktop.build` retains the MSIX
deployment version. Package identity is preserved for activation. For example,
product `26.1021.31345` can ship in package `26.1021.3705.0`. Missing or malformed
product metadata falls back to the deployment version and cannot select a
three-part audited voice profile. Do not derive one version from the other.

Voice selection uses product version plus platform when resource names are
absent. A complete, unambiguous asset pair can identify a profile without version
metadata. Mixed or partial pairs and contradictory platform metadata fail closed.
`CODEXHOST_DESKTOP_VERSION` remains an explicit diagnostic override.
