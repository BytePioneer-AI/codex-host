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
- **THEN** the update status reports the failure and the next `codexhost` or `codexhost web` starts the installed version
