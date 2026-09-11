## Decisions

Keep history projection and strict file verification inside the Adapter. Native Fork creates an exclusive prefix; verify a distinct identity before accepting cleanup ownership. Compare ordered semantic history (ignoring regenerated Item IDs and native references), source identity/history/configuration before and after, and derived Model/Thinking/Permission Mode. Empty derived Sessions persist selection metadata. Failure deletes only an independently created candidate. Source and candidate must be idle. Native clients outside this Host remain outside local transaction guarantees.

Strict verification requires successful native path and diff reads, reliable diff entries and coverage of all native patch paths. It never invents file changes or silently replaces unreadable history with an empty result. Extract this cohesive projection responsibility from the already oversized Adapter module.

Cancelled session.error triggers the existing status/transcript reconciliation. Only idle can complete cancellation. Follow-up Turn semantics remain upstream cancel/terminal/new-Turn.

## Validation

Unit failures: same-count corruption, source mutation, reused identity, incomplete diff, incompatible configuration, attachment failure, busy Session and early abort error. Real CLI: Edit file, Fork exact prefix, rollback first Turn without file rewind, cold resume and repeated edit. Record actual native versions and configuration isolation.
