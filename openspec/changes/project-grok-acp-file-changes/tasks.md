## 1. ACP Diff Parsing

- [x] 1.1 Add a focused Grok ACP Diff parser with strict path/text validation, bounded deterministic Unified Diff serialization, and conservative change kinds
- [x] 1.2 Add parser tests for update, explicit add, malformed, no-op, and oversized inputs

## 2. Live And Historical Projection

- [x] 2.1 Project only successful terminal Grok Tool Diff Content as a succeeded File Change Item after its owning Tool
- [x] 2.2 Reconstruct the same successful File Change Items from Native history while ignoring provisional and failed Diff updates
- [x] 2.3 Add focused live and resume tests covering terminal authority, exactly-once projection, failure degradation, and stable history

## 3. Validation And Documentation

- [x] 3.1 Update Grok integration documentation with the verified ACP Diff source and conservative limitations
- [x] 3.2 Run Grok focused tests, package typecheck, formatting, strict OpenSpec validation, and diff hygiene
