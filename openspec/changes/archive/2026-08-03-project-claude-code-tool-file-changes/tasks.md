## 1. Native Tool Interpretation

- [x] 1.1 Add finite private Claude Tool start, progress, completion, output, and native file-result event types
- [x] 1.2 Interpret and correlate complete Assistant Tool Use, User Tool Result, optional Tool Progress, malformed lifecycles, and Turn terminals
- [x] 1.3 Add hermetic native-message and SDK transport tests for Tool correlation, errors, absent progress, interleaving, and existing text/reasoning behavior

## 2. Reliable Claude File Changes

- [x] 2.1 Add strict Claude Edit/Write structured-patch validation and deterministic Unified Patch serialization
- [x] 2.2 Add focused patch tests for Edit update, Write create/update, multiple hunks, invalid paths/counts, and missing native evidence

## 3. Harness Session Projection

- [x] 3.1 Track active Claude Tools and map Bash to Command Execution and other Tools to Generic Tool Items with bounded output
- [x] 3.2 Emit reliable File Change Items after successful Edit/Write completion and preserve Tool-before-File-Change ordering
- [x] 3.3 Finalize active Tool Items before cancelled or failed Turn terminals while preserving Interaction and text/reasoning behavior
- [x] 3.4 Add Claude Adapter tests for Command, Generic Tool, File Change, malformed/no-patch results, cancellation, terminal ordering, and continuation

## 4. Verification And Documentation

- [x] 4.1 Run focused Claude Adapter tests, package typecheck/build, formatting/lint checks, and strict OpenSpec validation
- [x] 4.2 Update the development status documentation to record live Claude Tool/File Change projection and the remaining complete-history boundary
