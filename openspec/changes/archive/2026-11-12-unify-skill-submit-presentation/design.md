# Design

## Context

Host currently assigns temporary-operation semantics from the command entry point, while several Adapters invoke native conversation execution through that same entry point. Web submission echoes retire primarily when a matching user message or queue row is observed.

## Decisions

- Execution start carries an explicit conversation/operation classification before visible Items. The command directory describes selection and invocation, not the authoritative outcome of execution. Unclassified execution cannot silently default to a temporary command card. Compact retains its existing operation acceptance path: successful `commands.execute` immediately sets `thread.clientCommand`, with `#manualCompactionTurns` retaining the original manual-compaction association.
- Preserve existing request and client-message identifiers in independent external Harness submission receipts. Associate queued and steered submissions with actual execution, and update only receipts attached to a terminal execution. Operation acknowledgement does not require a synthetic user message.
- Official Codex `/compact` uses its original native command route and accepts responses without a Turn ID. It does not enter the external submission-receipt loop. No new compact correlation protocol, synthetic terminal identity, or inference from a later Turn is in scope.
- Pi prompt disposition and OMP agent-invocation acknowledgement distinguish locally handled extensions from native agent runs. Classification follows native fences, not absence of a Native Turn identity at completion.
- Keep the serialized invocation carrier separate from its visual Skill label. Reuse the existing Composer reference and user-message decoration paths; Adapter owns expansion and native calls.

## Risks / Trade-offs

- Protocol changes require all in-tree execution implementations and their fixtures to agree. Validate compilation plus real Adapter catalogue/execution integration, not fabricated directory flags.
- Ordered native events can precede acceptance. Keep Host projection gated until admission, and test fast completion and reconnect snapshots.
- Process-local operation receipts are not native conversation history. They must remain bounded and not be represented as durable native Turns.

## Migration

Deploy compatible Host and bundled plugins together. No conversation history rewrite or native Skill-loading change. Do not restore the prior optional directory execution-mode patch.
