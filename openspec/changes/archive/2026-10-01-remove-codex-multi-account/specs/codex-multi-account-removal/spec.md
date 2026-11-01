## ADDED Requirements

### Requirement: Host SHALL NOT manage multiple Codex accounts

CodexHost SHALL NOT provide Codex multi-account lifecycle. Host SHALL NOT store saved Codex credential copies, run Settings device-code login, replace official `auth.json` to switch accounts, stop Codex processes in order to switch, delete saved accounts, recover a Host account journal, or expose Host logout that clears native login while keeping a saved copy. Account, Harness, Model, Provider and Billing Source remain distinct; this change SHALL NOT add a Model proxy or per-Thread account routing.

#### Scenario: Settings has no multi-account actions

- **WHEN** the user opens Settings → Accounts
- **THEN** the page SHALL NOT offer add, login, switch, Host logout, delete saved account, recover, or consume reset credits

#### Scenario: Removed Host account methods have no dedicated handler

- **WHEN** a client sends `codexhost/account/switch`, `codexhost/account/login/start`, `codexhost/account/login/cancel`, `codexhost/account/logout`, `codexhost/account/delete`, `codexhost/account/recover`, or `codexhost/account/rate-limit-reset/consume`
- **THEN** Host SHALL NOT run a dedicated handler for that method
- **AND** Host SHALL NOT return an account-specific unavailable or unsupported result
- **AND** the request SHALL follow the same path as other methods Host does not own

#### Scenario: No Host credential vault is used

- **WHEN** Host starts or the accounts page refreshes
- **THEN** Host SHALL NOT read, write, rewrite, or salvage `.codexhost-native-accounts`
- **AND** leftover Vault or 0.8.x account records MAY remain on disk unused

#### Scenario: Switching is not performed by replacing native auth

- **WHEN** more than one ChatGPT or Codex login exists on the machine or in leftover files
- **THEN** Host SHALL NOT install a non-current credential into the permanent `auth.json`
- **AND** Host SHALL NOT stop the owned official backend or other Codex processes in order to change accounts
- **AND** ordinary owned-backend start, stop, and remote connection SHALL remain available for non-switch work

### Requirement: Settings accounts page SHALL only display identity and quotas

Settings → Accounts SHALL be a read-only identity and quota page. It SHALL show the current official Codex identity when one is available, current Codex quota from official rate limits, and other Harness rows returned by `inspectAccount()`. Missing quota windows SHALL remain omitted rather than filled with zero. Existing Settings refresh of displayed data MAY remain; this change SHALL NOT add a quota surface or refresh mechanism. When official rate limits include reset credits, the page SHALL show the available count and SHALL NOT offer or perform a consume action. Host SHALL NOT consume reset credits. The existing menu bar or taskbar current-quota display SHALL remain.

#### Scenario: Current Codex quota is shown

- **WHEN** official Codex is logged in and rate limits are available
- **THEN** the page SHALL show that account's identity and 5-hour / 7-day quota windows from official native rate limits
- **AND** the existing menu bar or taskbar current-quota display SHALL remain
- **AND** this change SHALL NOT add a quota surface or refresh mechanism for that display

#### Scenario: Other Harness quotas stay read-only

- **WHEN** a loaded Harness returns a valid `inspectAccount()` snapshot
- **THEN** the page SHALL show that Harness row as native-managed and read-only
- **AND** it SHALL NOT add, switch, or delete that Harness account

#### Scenario: No current Codex login

- **WHEN** official Codex has no current account
- **THEN** the page SHALL still show other Harness quota rows that are available
- **AND** it SHALL NOT start a Host-owned login to create a Codex account

#### Scenario: Reset credits are display-only

- **WHEN** official rate limits include reset credits for the current Codex account
- **THEN** the page SHALL show the available count
- **AND** the page SHALL NOT offer a use-reset or consume action
- **AND** Host SHALL NOT perform `codexhost/account/rate-limit-reset/consume` or keep a dedicated handler for it

### Requirement: Official Desktop authentication SHALL remain native

Desktop `account/login/*` and `account/logout` SHALL continue to be handled by the official backend. Host MAY update the displayed current identity after native authentication notifications. Host SHALL NOT collect native credentials into a Host store, SHALL NOT replace login identifiers, and SHALL NOT treat official login success as a multi-account save.

#### Scenario: User signs in from official Desktop

- **WHEN** official Desktop completes native login
- **THEN** subsequent native Codex work SHALL use that official identity
- **AND** Settings SHALL display the new current identity and quota when available
- **AND** Host SHALL NOT write a second saved copy for later Host switching

#### Scenario: User signs out from official Desktop

- **WHEN** official Desktop completes native logout
- **THEN** Host SHALL NOT restore a previous credential from leftover files
- **AND** Settings SHALL stop presenting that identity as current
