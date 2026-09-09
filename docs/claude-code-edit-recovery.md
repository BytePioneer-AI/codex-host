# Claude Code edit recovery

Editing the last message retains the earlier native history in an independent Session. When no earlier Turn remains, codexhost persists an empty Session reservation before returning the edit result. Closing before resend and reopening the Thread preserves that identity and its Model, Thinking and Permission Mode.

Reservations live under `CLAUDE_CONFIG_DIR/codexhost/pending-sessions` (default `~/.claude/codexhost/pending-sessions`). A creation claim prevents two wrappers from independently starting the same reserved Session. A missing transcript after native input was submitted is an error, not an empty conversation. Do not remove reservation metadata to repair a missing transcript.

Native interruption markers belong to their matching human prompt; literal user text is retained. An immediate history read waits for known completed native messages to reach the transcript and returns a retryable busy error if persistence remains delayed.

The Claude transport waits for its owned Unix process group and observed background tasks during close. Failed termination or output drain is reported to the caller. This does not stop unrelated CLIs or establish lifecycle guarantees for other Harnesses. Windows process-tree handling requires platform validation.

Empty reservations are a new Adapter-owned format. Versions without this reader cannot recover those empty identities; retain metadata/transcripts and use a compatible version when rolling back an installation. Optional saved selection hints in resume and rollback also require the matching Broker build for brokered Sessions. Existing native transcript identities keep their original format.

Hard cancellation keeps the active Turn and its Transport owned until close succeeds. A late native terminal cannot bypass that wait. If shutdown fails, the Session faults and cannot start another Turn or confirm a history replacement.
