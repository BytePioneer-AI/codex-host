# github-release-background-update Specification Delta

## ADDED Requirements

### Requirement: Host stages verified updates silently in the background
For packaged installations, Host SHALL periodically check for a newer stable release in the background and silently stage the verified installer artifact or npm cache outside the active update handoff directory without stopping or restarting any running service or session. Source checkouts SHALL NOT run background staging. At most one target version SHALL be retained in staged storage, and obsolete staged data SHALL be removed once the running version is up to date.

#### Scenario: Background staging succeeds for a packaged installer
- **WHEN** a periodic background check discovers a newer installable stable release for a packaged macOS, Windows, or Linux installer
- **THEN** Host SHALL download and verify the exact target asset's size and SHA-256 digest into staged storage without creating an active update handoff
- **AND** update checks SHALL report the staged version and ready background state while running services continue uninterrupted

#### Scenario: Background staging succeeds for an npm installation
- **WHEN** a periodic background check discovers a newer installable stable release for a packaged npm installation
- **THEN** Host SHALL prefetch the exact CLI and platform packages into the npm cache without stopping services
- **AND** update checks SHALL report the staged version and ready background state

#### Scenario: Background staging fails after discovering a newer release
- **WHEN** a newer stable release is discovered but background download, verification, or npm prefetch fails
- **THEN** Host SHALL NOT stop running services and SHALL NOT record a user-initiated update failure in the active update status file
- **AND** update checks SHALL still report that a newer version is available alongside a bounded background download failure message
- **AND** background retries for that same version SHALL be bounded with backoff

#### Scenario: Staged artifact is cleaned once updated
- **WHEN** Host starts or checks updates on a version equal to or newer than the staged version
- **THEN** Host SHALL remove the obsolete staged files

### Requirement: User-triggered updates reuse verified staged artifacts
When a user starts an update matching a currently staged version, the update flow SHALL verify and reuse the staged installer artifact (or skip redundant npm prefetch when already staged) before entering the prepared handoff phase. If the staged artifact is missing or fails verification, the update flow SHALL seamlessly fall back to a live download.

#### Scenario: Restarting from a ready staged installer
- **WHEN** a user starts an update while a valid staged installer for that exact target version exists
- **THEN** Update Manager SHALL verify size and SHA-256 against the staged file and transition to prepared handoff without re-downloading from the network

#### Scenario: Staged artifact was removed before restart
- **WHEN** a user starts an update after the staged file has been deleted or corrupted
- **THEN** Update Manager SHALL fall back to downloading and verifying the target asset from the release URL

### Requirement: UI surfaces ready-to-restart, background-failure fallback, and active-task confirmation
The update UI SHALL notify users when a newer version is ready to restart and when a newer version was discovered even if background staging failed. When ready, the primary action SHALL indicate restarting to update. When background staging failed, the Updates page SHALL inform the user of the failure and offer both a retry action and the existing manual update commands and release link. Before starting a restart while tasks are running, the UI SHALL request user confirmation.

#### Scenario: Staged update is ready in UI
- **WHEN** update check reports a newer version with matching staged version ready
- **THEN** entry triggers SHALL display an update-ready indicator and tooltip
- **AND** the Updates page primary action SHALL offer restarting to apply the update

#### Scenario: Background download failed for a discovered version
- **WHEN** update check reports an available newer version whose background download failed
- **THEN** entry triggers SHALL still indicate that a newer version is available
- **AND** the Updates page SHALL display the bounded background download failure reason alongside a retry button and the manual update commands and release link

#### Scenario: User clicks update while sessions are running
- **WHEN** update check reports one or more running tasks and the user clicks update or restart to update
- **THEN** the Updates page SHALL ask the user to confirm that restarting will interrupt the running tasks before starting the update

## MODIFIED Requirements

### Requirement: Installer preparation reports bounded download progress
The Host and Update Manager SHALL persist a `downloading` status for installer artifacts with nonnegative `downloadedBytes` and a positive `totalBytes` derived from the verified GitHub asset size, and SHALL also report `npmDownload` progress when an interactive npm prefetch is active. Renderer SHALL be able to read that status and display progress while preparation is active. Download completion SHALL be followed by the existing size and SHA-256 verification before the operation becomes `prepared` and before the Launcher stops the managed Desktop.

#### Scenario: macOS DMG download is active
- **WHEN** a verified macOS Release asset is being downloaded
- **THEN** status SHALL expose bounded downloaded and total byte counts
- **AND** the fixed status operation SHALL remain responsive
- **AND** the managed Desktop SHALL remain running until download and verification finish

#### Scenario: Interactive npm prefetch is active
- **WHEN** a user-initiated npm update prefetches packages without an already staged cache
- **THEN** the Updates page SHALL render bounded npm download progress while preparation is active

#### Scenario: Installer download fails
- **WHEN** artifact download, size validation, or digest validation fails
- **THEN** status SHALL become `failed` with bounded error text
- **AND** the temporary artifact SHALL be removed
- **AND** the Launcher SHALL NOT stop the managed Desktop for that failed operation

### Requirement: Update restarts the background Host and Web
An update started by the user SHALL stop the background Web and Host before installation and SHALL leave Host and Web running the new version after relaunch; Host update checks SHALL expose the current running task count so interactive clients can confirm before restarting, while the Host start endpoint itself SHALL remain executable once confirmed and SHALL report the number of interrupted tasks. Session history SHALL be preserved and interrupted tasks SHALL NOT resume automatically. Background checks and downloads MUST NOT stop or restart Host or Web.

#### Scenario: User starts an update with a running task
- **WHEN** a task is running and the user confirms starting an update
- **THEN** Host and Web restart on the new version and the update result reports one interrupted task

#### Scenario: Only a phone is in use
- **WHEN** a new version has been staged in the background and the user has not started the update
- **THEN** Host and Web keep running on the current version

#### Scenario: Installation fails
- **WHEN** installation fails after Host and Web have stopped
- **THEN** the updater attempts to restore the usable installation once using the selected interface mode
- **AND** the update status remains failed and reports whether service restoration succeeded
