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

`markdown/` covers the streaming and settled grammars, including local file URL
and bare-space image behavior. Its upstream regression cases come from DSH
`e8fc11fcf7` (single tildes), `f723892c98` + `14ead62052` (multiline dollar math
and parser boundaries), and `c262a09fd0` (Windows destinations). Browser rendering
and touch/keyboard wide-table scrolling are covered by
`packages/web-server/test/browser/markdown-compatibility.test.ts`; the table
hover-capability change is extracted from `94ffdd2377`, with keyboard focus
ordered after the resting rule to preserve its precedence.

Run them alone with:

```sh
npx vitest run --config tests/vitest.config.js tests/dsh
```
