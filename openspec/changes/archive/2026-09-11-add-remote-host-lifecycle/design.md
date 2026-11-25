## Context

The managed remote entrypoint already knows how to detach a default Unix listener, and the Host Runtime refuses to overwrite an active socket. This is safe but leaves users unable to recover when a stock listener predates installation. Installation status currently validates files only. Lifecycle management belongs in `host-runtime`, which owns remote installation semantics and can use the manifest to avoid stringly typed shell orchestration.

## Goals / Non-Goals

**Goals:**
- Provide one-command start, stop, and runtime status on Unix SSH hosts.
- Automatically replace only a precisely verified stock Codex listener occupying the target socket.
- Keep repeated start/stop operations idempotent.
- Preserve current installation status fields and add runtime diagnostics.

**Non-Goals:**
- Kill every process named `codex`.
- Manage systemd, launchd, or machine-wide services.
- Start graphical ChatGPT/Codex Desktop.
- Support lifecycle process control on Windows.

## Decisions

### Use `/proc` or `lsof`-style socket ownership through an injectable platform boundary
Production Linux can resolve Unix socket inode ownership through `/proc/net/unix` and `/proc/<pid>/fd`; macOS can use `lsof`. The lifecycle module will isolate this lookup behind functions that tests can inject, keeping command semantics deterministic. Failure to identify an owner is an unknown conflict, not permission to kill.

### Verify process trees against manifest paths and command shape
A replaceable stock conflict must belong to the current uid, include an `app-server` subcommand with exactly one default `--listen unix://`, and resolve to the manifest's stock Codex launcher or its descendant. A managed listener may instead be the Node process whose exact title is `codex app-server desktop-ssh-websocket-v0.sock`; it must still own the target socket and resolve to the manifest's Node path. The implementation terminates only the verified listener tree root with `SIGTERM`, waits, and escalates to `SIGKILL` only after a bounded timeout.

### Start through the installed wrapper with explicit manifest environment
The command spawns the installed native wrapper with the default listener arguments and explicit `CODEX_INSTALL_DIR`, stock Codex, Node, Host Runtime, data directory, and managed marker variables. It does not depend on the current interactive shell having sourced the managed profile.

### Verify protocol identity, not socket existence alone
Runtime probing first connects directly to the Unix WebSocket and sends `codexhost/harness/inspect`; this recognizes the managed Desktop SSH WebSocket transport. When direct probing cannot classify the socket, it connects through stock `codex app-server proxy --sock <path>` and repeats the request, so a stock unknown-method response identifies a stock listener. Socket-only readiness is reported as unknown rather than running.

### Keep runtime details nested under installation status
`remote status` retains existing top-level installation fields and adds `runtime`, avoiding a breaking replacement of the current JSON contract.

## Risks / Trade-offs

- [Socket owner discovery differs across Unix platforms] → Keep platform-specific discovery narrow and covered by fixture-driven tests; fail closed if tools or proc metadata are unavailable.
- [Terminating a stock listener interrupts clients using it] → Restrict replacement to the exact target socket and installed stock executable, and expose the action in command output.
- [Protocol probing may depend on stock Codex behavior] → Bound the probe and distinguish unknown from stopped/conflict.
- [PID reuse can target an unrelated process] → Capture start identity and revalidate executable, uid, and command immediately before signalling.
