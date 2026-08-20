## 1. Official Host Transport

- [x] 1.1 Add exact-pinned official DSH Host client dependencies and implement validated loopback unary/event transport.
- [x] 1.2 Implement shared Host discovery, existing-process ownership, bounded local DSH Web startup, disconnect faulting, and shutdown.

## 2. Native Session Adapter

- [x] 2.1 Replace private JSON-RPC create/prompt/cancel flow with official Session create, model, prompt, cancel, and mux event APIs.
- [x] 2.2 Implement public-history Snapshot projection, mapped Native Session resume, and one-way visibility boundaries.
- [x] 2.3 Project or explicitly fail full-profile interactive requests without auto-approval or indefinite pending state.

## 3. Remove Replaced Runtime

- [x] 3.1 Delete the codexhost Cordis config, bridge, private Session root, obsolete transport code, and runtime-only dependencies.
- [x] 3.2 Update Host composition, environment configuration, release audit, tests, and affected DeepSeek integration documentation.

## 4. Validation

- [x] 4.1 Add focused unit and integration tests for Host discovery/ownership, official event/history projection, resume, cancellation, and incompatibility.
- [x] 4.2 Run a real local DSH Gate proving a codexhost-created Session appears in official `session.list`, continues after Adapter resume, and unrelated official Sessions remain unmapped.
- [x] 4.3 Run targeted TypeScript build, tests, lint, formatting, boundary, release-bundle, and strict OpenSpec validation.
- [ ] 4.4 Run the Desktop manual Gate against the local DSH Web profile.
