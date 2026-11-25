# Claude Code edit recovery

Editing the last message retains the earlier native history in an independent Session. When no earlier Turn remains, codexhost persists an empty Session reservation before returning the edit result. Closing before resend and reopening the Thread preserves that identity and its Model, Thinking and Permission Mode.

Fork and multi-Turn edit recovery use the Agent SDK's `forkSession()` with the Desktop workspace as the project lookup directory. Claude Code can move a native Session into a worktree through `EnterWorktree`; its metadata `cwd` can then differ from the Desktop workspace. The SDK locates that Session in the project's worktrees, and the Adapter verifies the derived history against the requested prefix. Explicit destination changes remain governed by the Host's `forkAcrossCwd: false` capability.

Reservations live under `CLAUDE_CONFIG_DIR/codexhost/pending-sessions` (default `~/.claude/codexhost/pending-sessions`). A creation claim prevents two wrappers from independently starting the same reserved Session. A missing transcript after native input was submitted is an error, not an empty conversation. Do not remove reservation metadata to repair a missing transcript.

Native interruption markers belong to their matching human prompt; literal user text is retained. An immediate history read waits for known completed native messages to reach the transcript and returns a retryable busy error if persistence remains delayed.

Closing Claude requires confirmation that its owned processes stopped and its output drained. If close cannot confirm release, a later close request can recheck it; the old Session stays unavailable and the Host cannot resume that Thread until release is confirmed. Delegation reads report the shutdown error, not a missing Thread.

On Unix, a retry cannot signal a still-present process group after its original root has exited: the group ID may have been reused. The retry can confirm release once the group is absent and output has drained.

On Windows the current process-tree check still needs the original root process to be present. If the root has exited before the tree could be checked, retries cannot establish shutdown. Verify that no old Claude or descendant process can still write the Session before restarting Codex Desktop.

Empty reservations are a new Adapter-owned format. Versions without this reader cannot recover those empty identities; retain metadata/transcripts and use a compatible version when rolling back an installation. Optional saved selection hints in resume and rollback also require the matching Broker build for brokered Sessions. Existing native transcript identities keep their original format.

Hard cancellation keeps the active Turn and its Transport owned until close succeeds. A late native terminal cannot bypass that wait. If shutdown fails, the Session faults and cannot start another Turn or confirm a history replacement.
