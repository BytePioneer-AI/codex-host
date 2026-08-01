## Why

The codexhost settings shell currently renders fixed English copy even when Codex is using another interface language, and users cannot correct or intentionally choose the shell language from the settings experience itself. The shell needs a visible, bounded language control that follows the actual Codex application setting while preserving the existing browser-only and method-specific boundary.

## What Changes

- Read the Codex `localeOverride`, IDE locale, and system locale through fixed, validated, read-only Renderer Adapter operations, with browser-language and English fallbacks when the private protocol is unavailable.
- Provide owned English and Simplified Chinese message catalogs for the settings trigger, shell, navigation, search, accessibility labels, and foundation pages.
- Add a prominent interface-language selector above settings search with Automatic, English, and Simplified Chinese options.
- Write only the bounded Codex `localeOverride` values `null`, `en-US`, or `zh-CN` through one fixed method-specific operation.
- Keep the dialog open and retain the active settings page across successful language changes; restore the prior selection and show an inline error when a write fails.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `extensible-settings-shell`: Add locale resolution, owned English and Simplified Chinese presentation, and a visible bounded language selector to the existing settings shell contract.

## Impact

- Affects `packages/renderer-extension` locale adaptation, settings lifecycle, messages, icons, shell DOM/CSS, public browser-safe exports, and focused tests.
- Uses Codex Desktop's version-sensitive `vscode://codex` fetch bridge only inside a fixed locale Adapter; it adds no generic IPC/request surface, Node.js dependency, Host Runtime method, persistence store, or credential access.
- Writes the existing Codex application-level `localeOverride` setting and adds no codexhost-owned migration data.
