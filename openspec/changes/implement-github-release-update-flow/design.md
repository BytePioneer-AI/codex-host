## Context

The current worktree already contains a Node `@codexhost/update-manager`, a native temporary Updater, strict status/request files, distribution metadata, and npm/Inno/DMG installation implementations. Production release artifacts contain the helper and metadata, but no runtime module discovers a Release, resolves the installed layout, invokes the manager, or closes the managed Desktop after the helper starts. The Renderer settings shell already supplies a browser-only page registry and cancellable page scope, while its host request manager already exposes only reviewed method-specific operations.

The current PRD still calls the update mechanism undecided. This change makes the already chosen GitHub-only stable update path explicit: public GitHub Releases are the only catalog and artifact source, npm remains the npm installation source, and no codexhost service or additional release metadata file is added.

## Goals / Non-Goals

**Goals:**

- Discover the latest stable release from the public GitHub Releases API and bind one exact asset to the packaged target.
- Use GitHub's asset size and `sha256:` digest as the existing manager's download inputs.
- Resolve installer/npm paths from packaged metadata plus Launcher-supplied runtime identity, without accepting paths or URLs from Renderer.
- Expose fixed check/start/status operations and one serialized update operation per installed application.
- Start the temporary helper before requesting a normal Electron Desktop quit, then let the Launcher and existing Host cleanup paths settle before replacement.
- Recover and display the final status after relaunch through the existing settings shell.

**Non-Goals:**

- Custom `update.json`, `checksums.txt`, a codexhost update server, rollout percentages, prerelease channels, or telemetry.
- Developer ID, notarization, Authenticode, automatic privilege escalation, or bypassing platform policy.
- Updating Codex Desktop, Pi, Claude Code, Harness configuration, or user data.
- Renderer-supplied URLs, versions, digests, commands, paths, package names, or generic Host methods.
- Showing live UI after Desktop has exited; the new process reports the terminal result.

## Decisions

### 1. `update-manager` owns trusted Release and installed-distribution resolution

Add a narrow GitHub client for `GET https://api.github.com/repos/BytePioneer-AI/codex-host/releases/latest`. It strictly accepts one stable non-draft release, a `v<semver>` tag, a bounded plain-text Release body, the release-notes URL, and bounded assets. The selected installer asset name is derived exactly from version and packaged target. Its GitHub `size` and lowercase `sha256:` digest become `ArtifactSource`; missing or malformed digest fails automatic preparation.

The manager also reads strict packaged `codexhost-distribution.json`, derives installer paths relative to the production Host bundle, accepts npm-only absolute paths supplied by the packaged npm launcher, and discovers the newest valid local status under one platform state directory. It does not accept a repository name or arbitrary asset pattern from Renderer.

Alternative: add a custom static manifest. Rejected because GitHub already returns the stable version, notes, assets, size, URL, and digest required by the current manager.

### 2. Shared Contracts expose three empty-param, method-specific operations

Add strict browser-safe results for update check, start, and status. The operations carry no URL, path, digest, command, package, target override, or requested version. Check returns current/latest version, availability, bounded plain-text release notes, release-notes URL, and bounded failure text. Start installs only the Host's current candidate. Status returns only the normalized installation, phase, version, timestamp, and bounded error.

The existing Renderer request-manager client adds explicit methods for these operations. No generic requester enters settings code.

### 3. Host Runtime is the privileged update composition owner

Production Host composition creates one update coordinator from process environment and the Host bundle location. It parses the packaged distribution, checks GitHub, selects the current target, serializes prepare/start with an atomic local operation lock, and routes only the three fixed methods. A second start while an operation is prepared or active returns the existing status rather than spawning another helper.

Immediately before start, Host refreshes the current Release and rejects a stale candidate. After the helper reports a PID, Host sends the success response and schedules a bounded Controller shutdown request. Normal app-server stream closure drives the existing Adapter, Session, official app-server, and Mapping Store cleanup.

Alternative: run updates directly in Renderer or Desktop Controller. Rejected because Renderer cannot own filesystem/network/process privileges, while the Host already owns reviewed fixed request routing and can compose the Node manager. Desktop Controller owns only managed Desktop activation and shutdown.

### 4. Launcher supplies minimal runtime identity and Controller owns graceful Desktop quit

Launcher adds its PID, canonical executable, Controller loopback port, and nonce to the managed Desktop environment. These values identify the exact Launcher the temporary helper must wait for and authenticate a fixed local Controller command. npm launcher additionally supplies the absolute system Node, npm CLI, npm meta launcher, and platform package root; installer layouts derive from the Host bundle location.

The existing Controller attachment server accepts either `ATTACH <nonce>` or `SHUTDOWN <nonce>`. Shutdown stops new attachment work, responds, and invokes Electron main-process `app.quit()` through the existing Inspector session. Desktop exit causes Host cleanup and Launcher supervision to stop Controller and release its guard. The helper then observes Launcher exit and installs.

Alternative: terminate Launcher or Desktop by PID from Host. Rejected because it bypasses existing cleanup and increases Windows file-occupation races.

### 5. Updates is one cohesive settings page

The production registry adds an Updates page after Gateway. The page uses a method-specific client supplied by the binding lifecycle. On mount it checks current status and the latest Release. It renders current/latest version, bounded Release body text, an external release-notes link, one Update and Restart command, bounded waiting/failure states, and retry. It uses page `runLatest` and abort semantics, never fetches GitHub directly, and never renders arbitrary Release Markdown as HTML.

Installer download and preparation expose a bounded byte-progress state. The Node downloader reports each received chunk against GitHub's declared asset size, persists throttled progress in the discoverable status file, and the Host returns from start as soon as the operation status exists. The Host starts the temporary Updater and requests Desktop shutdown only after the artifact is fully downloaded and verified. Once shutdown begins the UI disappears; after relaunch the page discovers and polls a `restarting` operation until terminal, then reports success or failure. npm installation remains phase-only because its package installation occurs after the old application exits.

### 6. Local operation state is discoverable and bounded

The update state root is platform application data, outside install roots. Every operation remains an isolated directory, but the manager can enumerate strict status files, select the newest by `updatedAt`, and clean terminal directories older than a retention bound. An atomic lock prevents concurrent helpers across Host processes. Unknown, malformed, symlinked, or non-regular state is ignored or quarantined from control decisions.

`restarting` observed immediately after relaunch is valid because the helper spawns the new application before writing `succeeded`; the page polls briefly instead of declaring failure.

## Risks / Trade-offs

- [GitHub API is offline or rate-limited] -> Cache the last successful check locally, keep normal launch available, and expose retry only when the user opens Updates.
- [GitHub asset digest is absent] -> Show the Release and notes but disable automatic installation with an honest error.
- [Two Host processes race to update] -> Use one atomic state-root lock and bind start to the refreshed current candidate.
- [Desktop refuses to quit] -> Helper times out after its existing 180-second wait and records failure without modifying the installation.
- [macOS application parent is not writable] -> Record a permission failure; a later platform authorization dialog may retry, but this change does not silently elevate.
- [New process starts before helper writes success] -> Treat `restarting` as pending and poll the discoverable local status.
- [Private Electron behavior changes] -> Keep quit inside the version-reviewed Controller Inspector and fail without force-killing from Renderer.

## Migration Plan

1. Add specifications and update the PRD decision.
2. Extend Shared Contracts and `update-manager` with Release/distribution/status coordination.
3. Add Launcher environment and Controller shutdown control with focused process tests.
4. Compose fixed update methods in Host Runtime and extend the method-specific Renderer client.
5. Add the Updates settings page and lifecycle tests.
6. Run focused checks, full check/build, release contract tests, and strict OpenSpec validation.
7. Execute real npm, Windows x64/ARM64, and macOS arm64/x64 old-to-new upgrade gates; retain unverified targets as pending.

Rollback removes the new request routes, page, and Controller shutdown command. Existing packaged helpers remain inert and existing application/session data needs no migration.

## Open Questions

- macOS replacement in a non-writable parent remains a real-platform follow-up; the current explicit failure is the supported fallback.
- Real Windows ARM64 validation requires a native ARM64 environment and cannot be inferred from cross-build success.
