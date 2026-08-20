## 1. Native Event Mapping

- [x] 1.1 Add a focused Grok auto-compact mapper for start/complete/fail/cancel updates and ignore checkpoints
- [x] 1.2 Route `_x.ai/session/update` and documented session-notification aliases through the existing Transport update path
- [x] 1.3 Add mapper tests for snake_case, camelCase, checkpoint ignore, and unknown updates

## 2. Live And Historical Projection

- [x] 2.1 Project auto-compact onto `HostContextCompactionItem` on the active Turn, matching Pi's item lifecycle
- [x] 2.2 Reconstruct the same compact Items from Native history
- [x] 2.3 Publish context usage from succeeded compact token counts
- [x] 2.4 Add focused live and resume tests for success, failure, no-active-Turn ignore, and history reconstruction

## 3. Validation And Documentation

- [x] 3.1 Update Grok integration documentation to describe auto-compact projection and the manual-compact deferral
- [x] 3.2 Run Grok focused tests, package typecheck, formatting, and diff hygiene
