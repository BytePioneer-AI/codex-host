## Context

CodexHost currently owns a Codex multi-account control plane: a plaintext v3 Vault, Settings device-code login, global credential replacement, external Codex process stops, inactive WHAM quota refresh, and Host routes for switch/login/logout/delete/recover. Settings → Accounts also shows current Codex official rate limits and other Harness `inspectAccount()` snapshots.

`SingleNativeCodexAccount` already exists as a read-only fallback when management is unavailable. Official Desktop `account/login/*` and `account/logout` are forwarded to the official backend. This change makes the read-only path the only path.

`openspec/changes/implement-codex-native-accounts` is left unchanged. This change is the new product contract.

## Goals / Non-Goals

**Goals:**

- Remove Host-owned Codex multi-account lifecycle from contracts, Host, Renderer, switch-only native helpers, tests, and user docs.
- Keep Settings → Accounts as a read-only identity and quota page.
- Keep the existing menu bar / taskbar current-account quota display and official Desktop authentication on the official backend.
- Leave existing `.codexhost-native-accounts` files on disk unread.

**Non-Goals:**

- Do not build an external switcher, account pool, Model proxy, or per-Thread account routing.
- Do not change other Harness native authentication or `inspectAccount()`.
- Do not change official Codex request forwarding, Thread storage, or Harness picker.
- Do not delete or rewrite leftover Vault files.
- Do not stub removed account methods as `unavailable`, and do not add a compatibility layer or account-specific unknown-method errors.
- Do not remove ordinary official-backend start/stop or remote connection, and do not refactor remaining process/runtime machinery as cleanup.
- Do not add a quota surface or refresh mechanism.
- Do not edit `openspec/changes/implement-codex-native-accounts`.

## Decisions

1. **Delete dedicated handlers; do not stub or compatibility-wrap them.** Remove Vault, device-code login, switch/stop/recover, inactive quota refresh, and the dedicated Host handlers for switch, Settings login/cancel, Host logout, delete, recover, and reset-credit consume. Leftover requests take the existing path for methods Host does not own. Do not keep handlers that return `unavailable` or `unsupported`, and do not add a compatibility layer or account-specific error mapping. Alternative: leave the routes and always return unsupported. Rejected because that still exposes an account API.

2. **Current identity and quota are native-only.** Settings lists at most the current official Codex identity. Local startup initializes a read-only identity client on the existing owned backend before calling `controlRequest("account/read")`; removing the old account lifecycle must not remove that read connection. It creates no extra backend or login process and never reads credential files. Current quota uses official `account/rateLimits/read` and the existing menu bar / taskbar projection. Inactive WHAM / saved-credential OAuth refresh is removed. Alternative: keep WHAM for “other saved accounts” without switching. Rejected because that still requires a credential vault.

3. **Settings is display-only.** Remove add/login, switch, Host logout, delete, recover, and reset-credit consume from the accounts page. When official rate limits include reset credits, keep showing the available count; CodexHost never consumes them. Keep the existing Settings refresh of displayed data; do not add a refresh mechanism.

4. **Official Desktop authentication stays native.** Host continues to forward Desktop `account/login/*` and `account/logout` unchanged. After native auth notifications, Host may update the displayed current identity; it SHALL NOT copy credentials into a Host vault.

5. **Leave leftover Vault files unused.** Stop reading, rewriting, salvaging, and initializing `.codexhost-native-accounts`. Do not delete the directory. Users who need another Codex login use official Desktop login or an external switcher.

6. **Keep shared runtime by remaining use.** Delete switch-only process stopping, Host recover, and post-switch Thread navigation. Keep ordinary official-backend start/stop, remote connection, and other remaining callers of shared process or runtime code. Do not delete those mechanisms because account switching used them, and do not refactor them as cleanup. Remove the unused change/collection/recovery leases, switch-protection login tracking, and account `changing` phase; retain request admission and backend readiness. Remove Launcher `process-stop` and its exclusive inventory/identity helpers, not the process-instance and process-group termination used by normal shutdown.

7. **Delete unreachable product remnants too.** Remove management localization keys, device-login/delete styles, modal mutation actions, reset-consume callback parameters and tests, and the obsolete multi-account UI prototype. Empty-state copy directs users to native clients. Reset-card details remain read-only, and Harness switching is unaffected.

## Risks / Trade-offs

- **[Users who relied on in-app Codex switch lose it]** → Document official login and the read-only quota page. This is an accepted product break.
- **[Leftover Vault still holds plaintext credentials]** → Do not open or copy those files. Deleting them is out of scope; they remain user-local OS-permission files.
- **[Accidentally drop current quota or other Harness rows]** → Keep official current rate-limit inspect, the existing menu bar / taskbar quota display, and `codexhost/harness/accounts/*`. Do not add a quota surface or refresh.
- **[Leftover switch/login requests look like a still-supported API]** → Remove dedicated handlers so they follow the existing unknown-method path; do not return account `unavailable`.
- **[Ordinary backend start/stop or remote connection is deleted with switch helpers]** → Remove only switch-only stop/recover/navigation call sites; leave remaining runtime machinery in place.
- **[Accidentally own official login]** → Do not add Settings device-code login or Host logout as a replacement.

## Migration Plan

Ship as a breaking Settings/Host-API change. No Vault migration. Rollback is a version rollback; this change does not preserve a dual-stack.

## Open Questions

None. Remaining work is implementation against `codex-multi-account-removal`.
