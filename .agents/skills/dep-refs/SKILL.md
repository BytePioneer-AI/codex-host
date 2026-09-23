---
name: dep-refs
description: Trace TypeScript exports, imports, and re-exports in codexhost before refactoring interfaces or deleting code. Use available symbol tooling and repository searches to identify actual callers.
---

<!-- Adapted for codexhost from ZCode 872ad960de7ec172591f7e1952f7849229f94521. See ../NOTICE.md for provenance and licenses. -->

# Export and reference tracing

Work from the repository root. The ZCode-specific `pnpm dep:refs` and `pnpm knip` commands are not installed here; use current tools and package exports rather than adding dependencies for a lookup.

1. Read the target declaration and owning package's `package.json` exports. Follow its public entrypoint and any re-export chain.
2. Prefer a TypeScript language-service references query when the session provides one. Ensure it covers workspace callers, including `packages/adapters/*`, scripts and tests.
3. Use `rg` to find candidate references, then inspect aliases, namespace imports, re-exports and relevant consumers. For example:

```sh
rg -n --glob '*.{ts,tsx,mts,cts,mjs,js,json}' '\bHarnessAdapter\b' packages tests tools scripts
rg -n --glob '*.{ts,tsx,mts,cts,mjs,js,json}' '@codexhost/harness-adapter' packages tests tools scripts
```

4. For a deletion, search the whole repository, including hidden configuration when relevant. Check public exports, dynamic loading, plugin manifests, string-based dispatch and generated consumers. Read the current boundary checker before changing dependency directions.
5. Report concrete callers with paths and lines, re-exported public surfaces, and the limits of the search. Zero text matches or zero static references is not proof that an externally consumed export can be removed.

After changing an interface, validate its actual consumers with the applicable typecheck/build and focused tests from package scripts. This skill is read-only unless the user has also requested an implementation change.
