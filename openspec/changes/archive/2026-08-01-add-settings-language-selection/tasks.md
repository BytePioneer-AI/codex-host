## 1. Bounded Locale Adapter And Messages

- [x] 1.1 Implement fixed, cancellable, validated Codex locale override and locale-info reads with browser and English fallbacks.
- [x] 1.2 Implement a fixed locale override write that accepts only `null`, `en-US`, or `zh-CN` and exposes no generic request surface.
- [x] 1.3 Add immutable English and Simplified Chinese settings catalogs plus pure locale and selector mapping tests.

## 2. Settings Language Experience

- [x] 2.1 Localize the settings trigger, shell, search, navigation, accessibility labels, foundation pages, errors, and owned Shadow host language.
- [x] 2.2 Add the visible sidebar language selector before search with bounded options, pending state, failure restoration, and accessible inline error.
- [x] 2.3 Recreate the immutable shell registry after a confirmed language change while preserving the open dialog, active page, singleton trigger, and disposal safety.
- [x] 2.4 Add compact desktop and narrow-window styling with a bundled language icon, forced-colors fallback, and no page-level overflow.

## 3. Verification

- [x] 3.1 Add focused Adapter and localization tests for explicit, automatic, fallback, bounded write, unsupported locale, and cancellation behavior.
- [x] 3.2 Run Renderer and test TypeScript, focused Renderer and Release tests, ESLint, boundary checks, Prettier, three browser bundles, and diff checks.
- [x] 3.3 Run English and narrow Playwright smoke plus real Codex Desktop Automatic, English, Simplified Chinese, and restored-Automatic interaction Gates.
