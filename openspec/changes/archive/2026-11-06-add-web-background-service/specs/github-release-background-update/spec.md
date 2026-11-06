# Spec Delta

## ADDED Requirements

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
