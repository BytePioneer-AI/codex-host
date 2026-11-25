## Why

CodexHost-owned Codex multi-account login, switching, and credential vaults compete with a crowded switcher/gateway market while fighting the native Desktop architecture. The product should keep a read-only quota page and stop owning Codex account lifecycle.

## What Changes

- **BREAKING**: Remove Host-owned Codex multi-account management: credential vault, add/login, switch, Host logout, delete saved accounts, recover/rollback, device-code login, temporary login app-server, and switch-time process stops.
- Remove dedicated Host handlers for those account methods. Leftover requests follow the existing path for methods Host does not own. Do not keep `unavailable` stubs or add a compatibility layer.
- Keep Settings → Accounts as a read-only identity and quota page for the current Codex account and other Harness `inspectAccount()` snapshots. Show reset-credit count when official data includes it; CodexHost never consumes reset credits.
- Keep the existing menu bar / taskbar current-account quota display. Do not add a quota surface or refresh mechanism. Keep official Desktop login/logout on the official backend.
- Leave existing `.codexhost-native-accounts` files unused; do not migrate, salvage, or replay them.
- Do not edit `openspec/changes/implement-codex-native-accounts`. This change is the new product contract for Codex accounts.

## Capabilities

### New Capabilities

- `codex-multi-account-removal`: Host SHALL NOT manage multiple Codex accounts. Settings accounts page SHALL only display current identity and quotas.

### Modified Capabilities

None. `openspec/specs/` has no Codex account capability. The in-progress `implement-codex-native-accounts` specs are left unchanged.

## Impact

- Host Runtime: remove Codex account control, vault, device-code login, switch-only stop/recover, inactive-account quota refresh, and dedicated Host account routes. Ordinary official-backend start/stop and remote connection stay.
- Shared contracts and Renderer: drop multi-account operations, capabilities, Settings management UI, and post-switch navigation; keep existing read-only quota rendering, including menu bar / taskbar.
- Native helpers used only to switch accounts are removed from those call sites. Shared process and runtime machinery still used for start, shutdown, or remote is not deleted or refactored as cleanup.
- Tests and user docs for Codex account switching/login are replaced by read-only quota coverage.
- Official Codex authentication, other Harness native auth, and Harness `inspectAccount()` stay.
