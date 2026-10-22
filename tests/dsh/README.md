# Imported DSH tests

`workspace-files/` and `terminal/` are the upstream
`@deepseek-ai/dsh-api-workspace-files` and
`@deepseek-ai/dsh-api-terminal-controller` test suites from
`deepseek-harness` 0.2.1-alpha.1, with these import adaptations:

- Source imports name the vendored packages (`@deepseek-ai/dsh-api-workspace-files`,
  `@deepseek-ai/dsh-api-terminal-controller`, and their subpaths) instead of the
  upstream relative `../src` paths.
- `scope.spec.ts` and `binary-rpc.spec.ts` provide the CodexHost session seam
  (one local Thread's Host-recorded directory) instead of mounting the DSH
  session store and session-persistence services. Production replaces those
  services the same way; see `apps/web-ui/packages/host/dsh-web-backend`.
- Client terminal specs run under jsdom and alias the Gateway client entry to
  its TypeScript source, because the built browser bundle registers into
  `window.__ModuleLoader__`, which the unit-test environment does not install.

The suites use the upstream standard-decorator source, so they run through the
same Vitest pre-transform as the imported repository (`tests/vitest.config.js`).
They are excluded from `tests/tsconfig.json`: their modules are the imported
DSH sources, which are not part of the CodexHost Web TypeScript program.

Run them alone with:

```sh
npx vitest run --config tests/vitest.config.js tests/dsh
```
