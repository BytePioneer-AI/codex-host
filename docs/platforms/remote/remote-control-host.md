# Remote Control Harness Host

Codex Desktop's official Remote Control can expose a Windows workspace to another paired Codex Desktop without SSH. When both Desktops are launched through the same codexhost build, Harnesses installed and authenticated on the controlled Windows machine can be selected from the controlling Desktop.

This integration is experimental. It preserves OpenAI's pairing, account authentication, relay, environment discovery, and stock app-server protocol. codexhost does not operate a replacement relay or open a new TCP listener.

## Requirements

- The controlled Host runs Windows. A macOS controller is currently the verified configuration.
- Install the same codexhost build on both computers and launch both Codex Desktop instances through codexhost.
- Sign in to the ChatGPT account required by Codex Remote Control on both computers. Complete official Remote Control pairing first; codexhost cannot bypass account or device authorization.
- Install and authenticate the desired Harness on the controlled Windows machine. Harness credentials remain on that machine.

## Connect

1. On Windows, open **Settings → Connections → Control this computer**, enable access, and create a pairing code.
2. On the controller, open **Settings → Connections → Control other devices**, add the code, and select the Windows environment.
3. Open a project in that environment. In the composer Agent/Model selector, choose Pi, Claude Code, Grok, or another Harness available on Windows.

Prove that a stock Codex task works over Remote Control before diagnosing a Harness. Pairing failures, missing environments, and account authorization errors belong to the official Remote Control layer.

## Transport and security boundary

The official relay accepts only stock app-server methods and rejects private methods such as `codexhost/harness/inspect`. codexhost therefore carries its private LF-delimited app-server stream inside the stock `process/spawn`, `process/writeStdin`, `process/kill`, `process/outputDelta`, and `process/exited` methods:

1. The controlled Host Runtime atomically publishes its current random pipe identity and absolute packaged runtime paths to `%LOCALAPPDATA%\\codexhost\\remote-control-bridge-v1.json`.
2. The controller starts a fixed packaged bridge command through the already authenticated Remote Control app-server connection. That command reads the current descriptor instead of accepting paths or a command from the request.
3. The bridge process connects to the current-user Windows named pipe owned by the existing Host Runtime. It does not listen on a network interface.
4. A Host session on that pipe shares the controlled Host's Mapping Store and Harness adapters. Stock Codex requests that do not belong to an external Harness continue directly through the official app-server.
5. Prompts, streamed output, tool status, approvals, and diffs cross the official relay as protocol projections. Harness account files and project files are not copied to the controller.

Codex documents `process/spawn` as a standalone host process that does not run inside the Codex command sandbox. codexhost does not expose that capability to prompts or accept an arbitrary command: the renderer policy can launch only the fixed packaged bridge command. The current-user descriptor contains only the owner PID, random pipe identity, and absolute Node/Host Runtime paths; it contains no credentials, is replaced atomically on every Host Runtime start, and is accepted only while its owner PID is alive. The selected Harness still enforces its normal permission mode for project tools.

## Diagnostics

- `unknown variant codexhost/harness/inspect`: the private request reached the stock app-server directly. Upgrade/restart codexhost on both computers and reconnect the Remote Control environment so the bridge policy is installed.
- `process/spawn` or bridge startup failure: confirm the controlled Windows Desktop was launched through codexhost, both computers run a build with Remote Control Host support, and `%LOCALAPPDATA%\\codexhost\\remote-control-bridge-v1.json` names a live owner PID and absolute packaged paths. Reconnect the environment after restarting the controlled Desktop.
- `no active process for process handle`: the controlled Desktop restarted or the relay lost the prior bridge process. A failed bridge write invalidates that process identity immediately; retrying diagnostics or the action starts a fresh bridge from the current runtime descriptor.
- Bridge initialization timeout after restarting Windows: retry the failed action. codexhost abandons a bridge that does not complete app-server initialization within 15 seconds and the next request starts a fresh bridge against the current runtime descriptor.
- The Harness is absent but stock Codex works: run codexhost connection diagnostics on the controller, then verify the Harness installation and login on Windows.
- `Claude inbound is disabled`: the request reached the controlled Windows codexhost successfully, but Claude Code integration is disabled there. Enable Claude in the Windows codexhost GUI/config before retrying.
- Pairing fails before an environment appears: complete official Remote Control authorization with the required ChatGPT account; this is outside the codexhost bridge.
