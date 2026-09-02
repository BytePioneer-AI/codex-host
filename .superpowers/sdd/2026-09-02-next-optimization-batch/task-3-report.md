# Task 3 report: stabilize repository tests

## RED evidence

- Pre-task raw `npm test` evidence captured 26 macOS AppleDouble `._*` suites and failed with NUL parse errors.
- The pre-existing MappingStore cleanup assertions required only `EISDIR|ENOTEMPTY`, which is narrower than the platform-independent filesystem error contract.
- The Claude hermetic child Vitest invocation had no worker cap; the outer runner had previously flaked even when its child suite passed.

## GREEN evidence

- `npm run lint` — passed.
- `./node_modules/.bin/vitest run packages/mapping-store/test/index.test.ts --config tests/vitest.config.js --maxWorkers=1` — 1 file, 29 tests passed.
- `node tools/gate-claude-code/run.mjs hermetic` — 8 files, 33 tests passed.
- `./node_modules/.bin/vitest run tools/gate-claude-code/run.test.mjs --config tests/vitest.config.js --maxWorkers=1` — 1 file, 2 tests passed.
- `npm run test:typescript` — TypeScript build passed; 186 files passed, 3 skipped; 1,749 tests passed, 9 skipped.
- `./node_modules/.bin/vitest list --config tests/vitest.config.js --maxWorkers=1` listed 186 test-file paths with 0 `._*` matches, confirming AppleDouble discovery is excluded.
- `git diff --check` — passed.

## Changes and files

- `eslint.config.js`: globally ignores `**/._*`.
- `tests/vitest.config.js`: adds `**/._*` to Vitest's exported `defaultExclude` list, preserving normal defaults.
- `tools/gate-claude-code/run.mjs`: caps the hermetic child invocation with supported `--maxWorkers=1`.
- `packages/mapping-store/test/index.test.ts`: verifies a cleanup error has a filesystem error code without assuming a specific OS code.

## Commit

Implementation commit: `9fb2153` (`test: stabilize repository test discovery`).

## Self-review

- No dependencies, production MappingStore code, plans, ledgers, Grok outputs, or Skill files were changed.
- The existing repository-local untracked plan file was preserved and excluded from the commit.

## Concerns

No unrelated failures observed in the requested checks. The pre-task full-suite RED remains documented above; the post-change TypeScript suite is green.
