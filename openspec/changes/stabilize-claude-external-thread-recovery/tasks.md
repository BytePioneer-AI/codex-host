## 1. Claude History Classification

- [x] 1.1 Add bounded Claude transcript-noise and metadata classification for local-command output, caveats, and exact `/model` command envelopes
- [x] 1.2 Add mapper regression tests proving model controls are omitted while ordinary human text and non-model slash commands remain visible

## 2. Ordered Mapping Reconciliation

- [x] 2.1 Add an atomic Mapping Store API that reconciles a complete Snapshot-ordered mapping set while rejecting removal, reorder, rebinding, and Checkpoint changes
- [x] 2.2 Add Mapping Store tests for middle insertion, restart stability, idempotence, conflicts, and replacement failure
- [x] 2.3 Change External Thread Snapshot alignment to persist the complete validated mapping order through reconciliation
- [x] 2.4 Add a Host Repository regression test covering two consecutive alignments after Native Turns appear between persisted mappings

## 3. Validation

- [x] 3.1 Run focused Adapter, Mapping Store, and Host Runtime tests plus affected typecheck/lint checks
- [x] 3.2 Validate the OpenSpec change and record remaining live-record migration risk
