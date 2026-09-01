# Task 12B Report — Delegation Safety Documentation

Clarified the authoritative CLI Help and concise user-facing README without changing runtime behavior.

- Help now makes `approval-required` the explicit omitted-policy default and forbids Agents from choosing dangerous `unattended-full-access` without explicit user request or acceptance.
- Documented Pi creation/recovery fail-closed behavior and OMP's delegated `always-ask` default.
- Documented explicit Skill management, read-only status, conflict preservation, managed-only uninstall, retained parent directories, and retained quarantine/journal recovery files.
- README gives manual-cleanup safety guidance using exact reported paths and no glob or recursive deletion command.

TDD evidence:

- RED: 11 authoritative Help contract cases failed before the Help text was added.
- GREEN: the focused CLI suite passes all 32 tests.

Checks:

```text
npx vitest run packages/host-runtime/test/delegation-cli.test.ts --config tests/vitest.config.js
32 tests passed
npx prettier --check packages/host-runtime/src/delegation-cli.ts packages/host-runtime/test/delegation-cli.test.ts README.md
passed
npx eslint packages/host-runtime/src/delegation-cli.ts packages/host-runtime/test/delegation-cli.test.ts
passed
npm run build:typescript
passed
```
