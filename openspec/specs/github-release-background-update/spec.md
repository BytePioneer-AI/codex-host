# github-release-background-update Specification

## Purpose
TBD - created by archiving change implement-github-release-update-flow. Update Purpose after archive.

## Requirements

### Requirement: Host discovers one stable GitHub Release
The update capability SHALL discover the latest stable codexhost version only from `https://api.github.com/repos/BytePioneer-AI/codex-host/releases/latest`, SHALL compare its `v`-prefixed tag with the packaged current SemVer, and SHALL keep check failure non-blocking for normal application launch. It MUST NOT require a custom manifest, checksum sidecar, codexhost server, login, or embedded GitHub credential.

#### Scenario: New stable Release exists
- **WHEN** GitHub returns a non-draft, non-prerelease Release with a valid newer `v<semver>` tag
- **THEN** Host SHALL report the current version, latest version, update availability, bounded plain-text GitHub Release body, and release-notes URL

#### Scenario: GitHub is unavailable
- **WHEN** an automatic update check times out, is rate-limited, or returns malformed data
- **THEN** codexhost SHALL continue its normal managed Desktop behavior and expose a bounded retryable check failure

### Requirement: Host selects only the packaged target asset
Host SHALL derive the expected installer asset name from the packaged distribution target and the discovered version. It SHALL accept only that exact Release asset's HTTPS download URL, positive bounded size, and lowercase GitHub `sha256:` digest as installation input. Renderer MUST NOT provide or override a URL, digest, path, package, target, or version.

#### Scenario: Matching asset is complete
- **WHEN** the current installer target is `windows-x64` and the Release contains exactly one valid `codexhost-<version>-windows-x64.exe` asset
- **THEN** Host SHALL prepare that asset using its GitHub size and SHA-256 digest

#### Scenario: Asset digest is unavailable
- **WHEN** the matching Release asset has no valid SHA-256 digest
- **THEN** Host SHALL report the Release as visible but automatic installation unavailable and SHALL NOT download or execute the asset

#### Scenario: Renderer supplies privileged update input
- **WHEN** a fixed update operation includes an undeclared URL, digest, path, target, package, command, or version
- **THEN** the control boundary SHALL reject the request before Update Manager consumes it

### Requirement: Installed distribution determines update execution
The update capability SHALL read strict packaged distribution metadata and resolve the current npm, Windows installer, or macOS installer layout before preparation. It SHALL reject a target or distribution mismatch and SHALL use only absolute verified runtime paths derived from the installed package and Launcher-supplied identity.

#### Scenario: npm distribution starts an update
- **WHEN** packaged metadata identifies npm and the fixed npm runtime paths are available
- **THEN** Host SHALL prepare the exact discovered version through the npm update path and SHALL NOT select a DMG or EXE

#### Scenario: Installer metadata does not match host target
- **WHEN** packaged metadata declares a target different from the running platform and architecture
- **THEN** automatic update SHALL fail before download or process shutdown

### Requirement: Installer preparation reports bounded download progress
The Host and Update Manager SHALL persist a `downloading` status for installer artifacts with nonnegative `downloadedBytes` and a positive `totalBytes` derived from the verified GitHub asset size. Renderer SHALL be able to read that status while preparation is active. Download completion SHALL be followed by the existing size and SHA-256 verification before the operation becomes `prepared` and before the Launcher stops the managed Desktop. npm updates MAY remain phase-only because npm installation occurs after the managed application exits.

#### Scenario: macOS DMG download is active
- **WHEN** a verified macOS Release asset is being downloaded
- **THEN** status SHALL expose bounded downloaded and total byte counts
- **AND** the fixed status operation SHALL remain responsive
- **AND** the managed Desktop SHALL remain running until download and verification finish

#### Scenario: Installer download fails
- **WHEN** artifact download, size validation, or digest validation fails
- **THEN** status SHALL become `failed` with bounded error text
- **AND** the temporary artifact SHALL be removed
- **AND** the Launcher SHALL NOT stop the managed Desktop for that failed operation

### Requirement: Update starts once and stops the managed Desktop process tree
Host SHALL serialize update starts across current Host processes. After successful preparation it SHALL respond to the initiating Renderer. On Windows it SHALL start the temporary Updater; on macOS the Launcher SHALL start that helper from the prepared request. The Launcher SHALL then stop the owned Desktop process tree without invoking Electron `app.quit()`. The helper SHALL install only after the exact Launcher exits.

#### Scenario: User starts the current candidate
- **WHEN** no update operation is active and the current candidate remains the latest stable Release
- **THEN** exactly one helper SHALL start and the Launcher SHALL stop the owned Desktop process tree after that helper is waiting for exit

#### Scenario: User clicks update repeatedly
- **WHEN** a prepared or active operation already exists
- **THEN** Host SHALL return its bounded current status and SHALL NOT prepare another artifact or start another helper

#### Scenario: Launcher does not exit
- **WHEN** the managed Launcher remains alive past the Updater wait timeout
- **THEN** the helper SHALL record failure and SHALL NOT modify the installed distribution

### Requirement: Update status survives restart
The update capability SHALL store strict local operation status outside the installation root, discover the newest valid operation after relaunch, and expose only version, installation kind, phase, update time, and bounded error. It SHALL treat a freshly observed `restarting` phase as pending and SHALL clean stale terminal work without deleting active work.

#### Scenario: Updated application relaunches
- **WHEN** the new application starts while the helper status is `restarting` or `succeeded`
- **THEN** Host SHALL expose that operation until it reaches a terminal phase and Renderer SHALL be able to report the final result

#### Scenario: Prior update failed
- **WHEN** the latest valid operation contains a failed terminal status
- **THEN** Host SHALL return its bounded error and allow a later explicit retry

### Requirement: Release installation remains platform-specific
The existing background manager and native helper SHALL continue to use exact-version npm installation, per-user silent Inno Setup, and same-filesystem macOS App replacement with installed distribution verification and relaunch. Permission or platform-policy failure SHALL be reported without automatic elevation.

#### Scenario: macOS parent directory is not writable
- **WHEN** the Updater cannot stage or replace the App in its current parent directory
- **THEN** it SHALL preserve or restore the prior App and record a permission failure without invoking hidden privilege escalation

### Requirement: ARM64 Linux npm distributions SHALL use npm updates
Strict distribution metadata SHALL accept `linux-arm64`, SHALL require it to match a running `linux/arm64` host, and SHALL resolve its installed update context through the existing npm update path. It MUST NOT select or require a GitHub Release installer asset for Linux.

#### Scenario: ARM64 Linux npm installation checks for updates
- **WHEN** packaged metadata identifies distribution `npm` and target `linux-arm64` on a `linux/arm64` host
- **THEN** Host resolves the verified npm package paths and reports npm installation availability
- **AND** update preparation uses exact-version npm installation
- **AND** no DMG, EXE, `.deb`, or `.rpm` installer asset is selected

### Requirement: Update restarts the background Host and Web
An update started by the user SHALL stop the background Web and Host before installation and SHALL leave Host and Web running the new version after relaunch, without checking whether tasks are running. It SHALL report the number of interrupted tasks. Session history SHALL be preserved and interrupted tasks SHALL NOT resume automatically. Background checks and downloads MUST NOT stop or restart Host or Web.

#### Scenario: User starts an update with a running task
- **WHEN** a task is running and the user starts an update
- **THEN** Host and Web restart on the new version and the update result reports one interrupted task

#### Scenario: Only a phone is in use
- **WHEN** a new version has been downloaded and prepared and the user has not started the update
- **THEN** Host and Web keep running on the current version

#### Scenario: Installation fails
- **WHEN** installation fails after Host and Web have stopped
- **THEN** the updater attempts to restore the usable installation once using the selected interface mode
- **AND** the update status remains failed and reports whether service restoration succeeded

### Requirement: Updates are available without Desktop
Authenticated Web users SHALL be able to check, start, and inspect an application update without Codex Desktop running. Web and Desktop SHALL share one update operation and status for the running Host installation. Concurrent requests MUST NOT install twice or update a different installation. A source checkout SHALL report that installation updates are unavailable.

#### Scenario: Web-only update
- **WHEN** only background Host and Web are running and a Web user starts an update
- **THEN** the update is prepared without stopping services, then installs and restores Host and Web on the selected version
- **AND** no Desktop window or browser window is opened, and existing access configuration and session history are preserved

#### Scenario: Desktop is also running
- **WHEN** a Web user starts an update while the managed Desktop is running
- **THEN** the update stops that Desktop before installation and restores the Desktop with the background services

#### Scenario: Concurrent requests
- **WHEN** two clients start an update while an update is already active
- **THEN** they observe the same operation or an explicit busy result, and no second installation starts

### Requirement: Update status survives connection loss
The Web update page SHALL continue bounded status recovery through expected service disconnection. It MUST NOT resend a start request automatically. Only an authoritative update result MAY be displayed as installation success or failure; inability to reconnect SHALL be shown as an unknown result.

#### Scenario: Services restart
- **WHEN** a started update temporarily disconnects the Web page and the services return
- **THEN** the page reads and displays the actual update result without starting another update

#### Scenario: Services do not return within the wait limit
- **WHEN** the page cannot reconnect before its bounded recovery deadline
- **THEN** it reports that the result cannot currently be confirmed and does not report an inferred installation failure
