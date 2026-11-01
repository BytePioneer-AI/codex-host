## 1. Public contracts

- [x] 1.1 Remove Host/Renderer Codex multi-account operation types: switch, Settings login/cancel/completed, Host logout, delete, recover, reset-credit consume, saved-account capabilities, `requiresLogin`, and pending login/switch operations.
- [x] 1.2 Keep a current-only Codex identity snapshot plus current-account usage inspect. Keep `codexhost/harness/accounts/*` unchanged.

## 2. Host Runtime

- [x] 2.1 Delete Vault, device-code login, credential collection, inactive WHAM/OAuth quota, switch/stop/recover, and Host-owned logout. Do not read or rewrite `.codexhost-native-accounts`.
- [x] 2.2 Serve Settings from a current-only native snapshot and official `account/rateLimits/read`. Remove dedicated handlers for switch, Settings login/cancel, Host logout, delete, recover, and reset-credit consume. Leftover requests use the existing path for methods Host does not own; do not return `unavailable` or add a compatibility layer.
- [x] 2.3 Keep forwarding official Desktop `account/login/*` and `account/logout`. After native auth notifications, refresh displayed current identity only.
- [x] 2.4 Remove switch-only process stopping, Host recover, and post-switch Thread navigation. Keep ordinary official-backend start/stop and remote connection. Do not delete or refactor remaining process/runtime machinery as cleanup.

## 3. Renderer Settings

- [x] 3.1 Make Settings → Accounts display-only: current Codex identity/quota, reset-credit count when official data includes it, and other Harness `inspectAccount()` rows. Keep the existing Settings refresh of displayed data; do not add a refresh mechanism.
- [x] 3.2 Remove add/login, switch, Host logout, delete, recover, reset-credit consume (including any use-reset control), and post-switch Thread navigation.
- [x] 3.3 Keep the existing menu bar / taskbar current Codex quota display. Do not add a quota surface or refresh mechanism.

## 4. Tests and docs

- [x] 4.1 Replace switch/login/vault/inactive-quota tests with current-only snapshot, official quota display, harness read-only rows, leftover Vault ignored, and leftover multi-account methods following the existing unknown-method path.
- [x] 4.2 Rewrite `docs/product/codex-accounts.md` and the native switching design as read-only quota docs. Remove switching claims from SSH/remote docs. Do not edit `openspec/changes/implement-codex-native-accounts`.
- [x] 4.3 Run focused Host/Renderer/contract tests, typecheck, and `npx openspec validate remove-codex-multi-account --strict`.
