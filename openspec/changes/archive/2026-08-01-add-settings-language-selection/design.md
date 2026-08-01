## Context

The archived settings-shell foundation owns browser-only DOM, CSS, page registration, and lifecycle, but all visible copy is fixed English. Codex Desktop stores the user override under `localeOverride`, exposes automatic inputs through `locale-info`, and routes settings operations through its private `vscode://codex` fetch bridge. The public DOM language is not reliable: the reviewed Chinese Renderer reports `document.documentElement.lang` as English.

The settings package must remain independent of Node.js, Electron imports, arbitrary IPC, and generic method/payload clients. Private Codex integration therefore belongs in a package-root Adapter, while the shell receives only a bounded language control.

## Goals / Non-Goals

**Goals:**

- Resolve the settings language from the actual Codex override and automatic locale inputs.
- Render all owned settings copy in English or Simplified Chinese and expose an accurate owned `lang` value.
- Put a visible language selector before search in the application-level settings sidebar.
- Persist Automatic, English, and Simplified Chinese through the existing Codex application setting.
- Preserve the open dialog and active page after a successful language change, and provide an accessible failure state.
- Fail safely when the version-sensitive private bridge or response shape changes.

**Non-Goals:**

- Supporting additional translation catalogs in this change.
- Exposing a generic Codex settings client, arbitrary URL fetcher, or Electron bridge to settings pages.
- Adding Host Runtime, Mapping Store, filesystem, or codexhost-owned locale persistence.
- Inferring the interface language from translated DOM text, React Fiber, or `document.lang`.

## Decisions

### 1. Isolate fixed Codex locale operations outside the settings package

A dedicated Renderer locale Adapter implements only `get-setting(localeOverride)`, `locale-info`, and `set-setting(localeOverride)`. It correlates private fetch responses by generated request ID, validates HTTP-style success and JSON shape, supports timeout and cancellation, and accepts only `null`, `en-US`, or `zh-CN` for writes. The browser-safe settings shell receives only `RendererSettingsLanguageControl.setSelection()`.

Alternative: expose a generic `request(method, payload)` helper. Rejected because it would bypass capability ownership and violate the existing settings boundary.

Alternative: parse `config.toml` in Renderer. Rejected because Renderer cannot access files and the file does not provide IDE/system automatic inputs.

### 2. Resolve Codex preference before selecting an owned catalog

A non-null validated override wins. Automatic mode prefers Codex's IDE locale, then system locale, then `navigator.languages`, with English as the final fallback. All Chinese language tags use the Simplified Chinese catalog for this two-language release; English variants use English; unsupported languages use English without pretending that the underlying Codex override changed.

If locale reads fail, the shell remains usable with the browser-language fallback and the write control stays disabled until a validated Codex settings connection is available.

### 3. Keep localization data owned and immutable

The settings feature owns immutable English and Simplified Chinese messages for trigger labels, shell controls, search, navigation, foundation pages, accessibility names, language options, and errors. The shell sets `lang` on its Shadow DOM host because Codex's document language is not a reliable input.

Alternative: consume Codex translation modules or private React Intl context. Rejected because those are build-private dependencies and would make shell rendering version fragile.

### 4. Recreate the immutable registry on language changes

The page registry remains immutable for one shell installation. A successful language update captures whether the dialog is open and its active page, disposes the old shell and trigger, mounts one localized replacement, and reopens the same page from the replacement trigger. This preserves the registry contract and avoids mutating contributed definitions in place.

The selector is disabled while a write is pending. A failed write restores the previous value and exposes localized inline alert text. Disposal aborts pending locale work and stale completions cannot update a replacement shell.

## Risks / Trade-offs

- [Codex private locale endpoints change] -> Validate every response, time out bounded requests, disable writes, and retain a usable browser-language fallback.
- [Automatic locale policy changes] -> Prefer the reviewed IDE/system inputs and never claim an unavailable override; unsupported catalog languages still fall back to English.
- [Language change replaces the focused control] -> Reopen through the replacement trigger and preserve the current page; disposal generation guards ignore old handler completions.
- [Codex already has an unsupported explicit locale] -> Show a disabled current "Other Codex language" option while allowing selection of Automatic, English, or Simplified Chinese.
- [Narrow layout gains another row] -> Keep the selector compact, retain horizontal navigation, and validate 480px containment and page overflow.

## Migration Plan

1. Add the fixed locale read/write Adapter and pure locale-selection/message helpers.
2. Compose the bounded language control through the settings lifecycle and localize shell, pages, trigger, icons, and CSS.
3. Validate explicit English, explicit Simplified Chinese, and Automatic round trips in real Codex Desktop, then restore the original override.
4. Rollback removes the locale Adapter and language control; the existing Codex setting remains valid and no codexhost migration data exists.

## Open Questions

None for the English and Simplified Chinese scope. Additional languages require separate reviewed catalogs and may refine automatic locale matching without expanding the fixed settings transport.
