# Optional macOS cold-start automation

The normal entry point is `codexhost`. Opening the official Codex/ChatGPT app
directly does not run that launcher. Users who want to keep their existing Dock,
Finder, or Spotlight entry can install the source-only automation in
[`tools/macos-auto-launch`](../../../tools/macos-auto-launch).

This is opt-in automation, not part of the installer or a new launch mode. A
small Swift listener receives `NSWorkspace` application notifications and invokes
the existing Rust launcher with `launch` and `CODEXHOST_CONSOLE=0`. That switch
disables automatic console startup and browser opening for this launch. The
launcher continues to own Desktop validation, process termination, runtime setup,
and injection; the listener does not patch either application bundle or implement
a second injection path.

**A cold start is automatically restarted once.** The just-opened official app
may briefly appear before the launcher replaces it with a controlled instance.
This is not hot injection into the original process. Do not use the automation
if this restart is undesirable. It does not forward an initial file-open or
deep-link request to the replacement process.

## Install

Requirements: macOS 13 or later, Xcode Command Line Tools with Swift 6, Python
3.9 or later, a working codexhost installation, and a clone of this repository.
Run as the logged-in user, without `sudo`:

```sh
python3 tools/macos-auto-launch/manage.py install
python3 tools/macos-auto-launch/manage.py status
```

The default launcher is
`/Applications/codexhost.app/Contents/MacOS/codexhost`. A custom installation can
select its native executable with `install --launcher /absolute/path/to/codexhost`.
This path must remain installed; a build output removed by `cargo clean` is not
a durable launcher location. The helper is compiled on this Mac and signed
ad hoc. Swift and Python are installation/test dependencies; the installed
listener does not invoke either interpreter or compiler at runtime.

Installation creates:

- `~/Library/LaunchAgents/ai.bytepioneer.codexhost.auto-launch.plist`;
- the helper, its source, manager, and logs under
  `~/Library/Application Support/codexhost/auto-launch/`.

The LaunchAgent runs at login and observes future launches. It does not open
Desktop at login. A Desktop already running when the listener starts or restarts
is left alone. No Accessibility or Apple Events control permission is required.
The listener retains no account credentials or conversation data.

## Scope and lifecycle

Only the unified Electron app with bundle ID `com.openai.codex` and an
`app.asar` resource is observed, regardless of whether its display name is Codex
or ChatGPT. The separate native ChatGPT app, browser sessions, remote Hosts,
and other operating systems are outside this tool's scope.

The listener deduplicates launch notifications, ignores its own controlled
relaunch, and leaves another existing Desktop instance alone. A live launcher
and the app's debugging argument identify an external codexhost launch while its
runtime descriptor is still being published. A quick quit/reopen waits up to
three seconds for the previous supervisor to finish. Notifications older than
eight seconds are skipped to avoid restarting an app already in use.

Missing launcher executables leave the official app running. A failed launcher
is not retried automatically, and further handoffs are paused for 30 seconds to
avoid a restart loop. Check the logs before retrying. As with a manual codexhost
launch, a failure after the original app has closed can leave Desktop closed.

This helper subscribes to Workspace notifications rather than polling all apps
while idle. During a handoff it checks launcher cleanup; while its supervisor is
active it checks that child's exit once per second. `events.jsonl` records
decisions and rotates after 1 MiB; `launcher.log` and `service.log` retain
launcher output and listener errors. Stop the listener before deleting logs.

## Remove

```sh
python3 tools/macos-auto-launch/manage.py uninstall
```

If the checkout is no longer present:

```sh
python3 "$HOME/Library/Application Support/codexhost/auto-launch/manage.py" uninstall
```

Uninstall removes the LaunchAgent and retains source/logs. Its
`AbandonProcessGroup` setting leaves an already-running codexhost supervisor
and Desktop session alive when the listener stops or is reinstalled. No Dock
entry, official application, or global LaunchServices environment is changed.

## Validate

```sh
npm run test:macos:auto-launch
```

The test compiles an independent fixture app and helper in a temporary directory
and exercises real LaunchServices/Workspace events: an existing app survives
listener startup; two cold starts each hand off once; a rapid quit/reopen waits
for cleanup; a controlled relaunch does not recurse; warm opens preserve the
process; a missing launcher leaves the app alive; and a failed launcher pauses
subsequent handoffs. It also checks the generated
LaunchAgent's silent console switch, path arguments, and process-group policy.
It never targets the real Desktop or installs the production LaunchAgent.

These tests establish notification and handoff behavior, not compatibility with
every Desktop build. Real injection still depends on the installed codexhost
and Desktop versions; test a real cold start during a convenient break from
active Threads. macOS app identifiers, launch behavior, and codexhost's CLI may
change in future releases.
