# Public contract guidance

Adapted for codexhost from ZCode; see [provenance](../../NOTICE.md).

Cross-package callers use the owning package's declared public exports. Inspect its `package.json` and entrypoint before adding a new import. Preserve runtime validation where data crosses a process or trust boundary.

`shared-contracts` contains browser-safe types and schemas and remains independent of other workspace packages. Native Session identity, lifecycle semantics and Harness-specific details follow the existing Harness contracts and Adapter ownership.

Document ordering, cancellation, error, and recovery semantics that types cannot express. Exercise the interface through callers and focused tests. Follow existing package structure; this skill does not require `module.ts`, `contract.example.ts`, a new package, or a separate CONTRACT.md for each change.
