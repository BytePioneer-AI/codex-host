# Implementation questions

Adapted for codexhost from ZCode; see [provenance](../../NOTICE.md).

For stateful or cross-package work, answer the questions relevant to the change:

| Decision | Evidence |
| --- | --- |
| Behavior | Existing feature document and concrete changed acceptance cases |
| Owner | Module that accepts writes; distinguish Native Session facts from Host metadata |
| Contract | Public exports and browser-safe runtime schemas consumed by callers |
| Reuse | Existing command, Adapter or projection path that already owns the behavior |
| Time | Event order, cancellation acceptance versus terminal outcome, stale-result and duplicate handling |
| Recovery | Native history source, persisted identity and reconnect behavior |
| Isolation | Target Host, Harness, Thread and Turn identity; verify local and remote paths separately |
| Validation | Focused tests or observed runtime evidence for the affected behavior |

A useful decision sketch is:

```text
input → owning command handler → native operation → confirmed event
                                   └── Host mapping and UI projection
```

Preserve a single owner for mutable facts. Renderer drafts and optimistic views remain distinct from accepted commands. Keep raw Harness protocols behind the corresponding Adapter, and distinguish a native capability from Host presentation of it.
