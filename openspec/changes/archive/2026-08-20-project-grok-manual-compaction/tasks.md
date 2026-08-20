## 1. Transport Compact Request

- [x] 1.1 Add Grok compact request helper for `x.ai/compact_conversation` with optional `userContext` and underscored method fallback
- [x] 1.2 Install a compact event listener so `_x.ai/session/update` compact notifications reach `onEvent` without an active Prompt
- [x] 1.3 Do not apply the 30s ACP command timeout to compact; honor `session/cancel` while compact is active

## 2. Adapter Command Catalog And Temporary Turn

- [x] 2.1 Publish `grok.compact` on the Grok Session command catalog
- [x] 2.2 Execute compact as a temporary Turn that reuses existing Context Compaction Item projection and usage refresh
- [x] 2.3 Reject unknown commands, invalid arguments, and busy Sessions; finish the Turn without a Native Turn identity

## 3. Tests And Documentation

- [x] 3.1 Add focused Adapter tests for catalog, argument/busy rejection, success/fail/cancel projection, and no Prompt passthrough
- [x] 3.2 Update Grok integration and Harness command docs to include Grok `/compact`
- [x] 3.3 Run Grok focused tests, package typecheck, formatting, and diff hygiene
