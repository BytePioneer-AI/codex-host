# Compat daily

Compares the public ChatGPT/Codex Desktop Sparkle appcast to Renderer voice pins. It does not download ChatGPT.app.

```bash
npm run compat:daily:test
npm run compat:daily
```

GitHub: `.github/workflows/compat-daily.yml` (daily 07:17 UTC, `workflow_dispatch`, and path-filtered push). Pin drift opens or comments `compat-broken` issues on this repository.

The local command prints JSON containing `latest`, `pins` and `findings`. It exits
with status 1 when either surface differs from Sparkle latest; fetch or parse
errors also fail the command. Running it locally does not create GitHub issues.
The workflow creates or comments on issues in its own repository on failing
non-PR runs. No command here updates pins or enables a Desktop build.

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
   the same directory. Chat pins/start assets live in `renderer-native-chat-voice.ts`;
   the parser uses Work version/initial pins if separate Chat constants are absent.
   Preserve independent Chat pins when Work advances. The 26.1016.61520 Chat
   audit found incompatible scope/export bindings and retains the 26.1013.40934
   pin; see the [native Instant Connect evidence](../../docs/operations/cpa-live-voice-desktop-hook.md#existing-and-new-chatgpt-conversations-native-instant-connect).
   Keep its drift issue open until the full Chat lifecycle is qualified.
4. Run `npm run compat:daily:test`, the behavior checks selected by the runbook,
   and `npm run compat:daily` again after any pin changes. Record remaining drift
   explicitly. A matching pin only clears version drift; it does not prove the
   native bindings or voice behavior work.
