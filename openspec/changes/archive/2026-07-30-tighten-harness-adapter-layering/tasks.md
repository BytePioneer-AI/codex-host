## 1. Shared Control Contracts

- [x] 1.1 Replace the Pi-literal Harness inspection params schema with a strict opaque Harness ID schema and update Renderer consumers and tests without changing the Pi wire request shape.
- [x] 1.2 Add finite Protocol Core decoding for an existing external Thread's transport Model carrier and cover base, selected Pi, malformed, and foreign carrier cases.

## 2. Generic Host Dispatch

- [x] 2.1 Remove concrete Pi construction and Pi-specific Adapter options from AppServerHost; inject explicit Adapter maps from production composition and Hermetic fixtures.
- [x] 2.2 Dispatch Harness inspection by registered Harness ID with validated generic results and explicit unregistered errors.
- [x] 2.3 Dispatch create-time and current-Thread Model selection through generic route output, Thread ownership, and Session capability, with a non-Pi Fake Adapter regression test.

## 3. Concrete Adapter Integrity

- [x] 3.1 Make Pi RPC state parsing reject missing or blank Native Session identity as `protocolError` and add a focused transport test.
- [x] 3.2 Make Claude inspection resolve installation without creating native resources, and return `unsupported` for Resume/Fork while preserving invalid create validation.
- [x] 3.3 Narrow the Claude package root exports and update package-internal and cross-package tests to use internal or inferred test seams.

## 4. Verification

- [x] 4.1 Run focused Shared Contracts, Protocol Core, Host Runtime, Pi Adapter, Claude Adapter, and Renderer tests plus typecheck and lint for changed modules.
- [x] 4.2 Run full repository checks, product build, and `git diff --check` without altering outstanding Fork Gate claims.
- [x] 4.3 Run strict OpenSpec validation and confirm implementation, delta specs, and task status agree.
