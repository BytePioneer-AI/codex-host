# opencode-managed-server Specification

## Purpose

Define the managed OpenCode Server process boundary used by the OpenCode Harness Adapter.

## Requirements

### Requirement: Managed Server startup directory is explicit and writable

The OpenCode Adapter SHALL start its managed OpenCode Server with an explicit, existing,
readable and writable neutral working directory. It SHALL NOT allow that Server to inherit the
Host process working directory. The requested workspace directory SHALL continue to be passed
only to the OpenCode SDK client as its directory scope.

#### Scenario: Host runs from a protected application directory

- **GIVEN** the Host process has a protected or otherwise unsuitable current working directory
- **WHEN** the Adapter starts its managed OpenCode Server for a writable workspace
- **THEN** the Server starts from an explicit neutral writable directory
- **AND** Provider discovery retains the requested workspace as its SDK directory scope

#### Scenario: No safe Server startup directory is available

- **WHEN** the Adapter cannot find a readable and writable neutral directory for the managed
  Server
- **THEN** it SHALL fail with an unavailable error before spawning the Server
- **AND** it SHALL NOT fall back to inheriting the Host process working directory
