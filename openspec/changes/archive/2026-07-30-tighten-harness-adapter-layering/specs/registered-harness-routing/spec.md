## ADDED Requirements

### Requirement: Harness controls dispatch through registered ownership
Host Runtime SHALL dispatch Harness inspection through the requested registered Harness ID and SHALL dispatch Thread Model selection through the owning HarnessSession and its declared Model-selection capability. These control paths MUST NOT require Pi ownership or inspect Harness-native configuration.

#### Scenario: Registered non-Pi Harness is inspected
- **WHEN** a valid Harness inspection request names a registered non-Pi Harness
- **THEN** Host SHALL call that Adapter's `inspect()` with the normalized cwd and refresh input
- **AND** it SHALL return the validated inspection without invoking PiAdapter

#### Scenario: Owning non-Pi Session supports Model selection
- **WHEN** a Model selection request references an external Thread whose Session declares `configuration.selectModel=true`
- **THEN** Host SHALL execute the existing `model.select` command on that owning Session
- **AND** it SHALL confirm the effective Model through ordered Session state without a Harness ID branch

#### Scenario: Owning Session does not support Model selection
- **WHEN** a Model selection request references a Session whose Model-selection capability is false
- **THEN** Host SHALL return an explicit unsupported error
- **AND** it SHALL NOT execute a Model command or invoke another Adapter

### Requirement: Protocol Core owns finite transport Model decoding
Protocol Core SHALL decode Desktop transport Model carriers for each finite external Harness and SHALL return only an opaque Harness Model Ref, no override, or a non-matching result to Host Runtime. Host Runtime MUST NOT parse Pi Model carrier prefixes.

#### Scenario: Pi selected carrier reaches a Pi Thread
- **WHEN** an existing Pi Thread receives a valid selected Pi transport Model carrier
- **THEN** Protocol Core SHALL return its opaque Harness Model Ref
- **AND** generic Host routing SHALL apply or verify that Ref through the owning Session

#### Scenario: Foreign carrier reaches an external Thread
- **WHEN** an external Thread receives a transport Model carrier that does not belong to its Harness
- **THEN** Protocol Core SHALL report that the carrier does not match
- **AND** Host SHALL NOT reinterpret it as a Harness Model Ref

### Requirement: Composition root exclusively constructs concrete Adapters
The production composition root SHALL construct concrete Pi and development-gated Claude Adapters and SHALL inject the complete external Adapter registry into AppServerHost. AppServerHost SHALL depend on HarnessAdapter and MUST NOT import or construct PiAdapter or ClaudeCodeAdapter.

#### Scenario: Production Host starts
- **WHEN** the Host Runtime entry point creates AppServerHost
- **THEN** it SHALL first create the external Adapter registry through the composition module
- **AND** AppServerHost SHALL use exactly that injected registry

#### Scenario: Hermetic Host test starts
- **WHEN** a Host test needs one or more external Harnesses
- **THEN** it SHALL inject explicit Fake HarnessAdapters
- **AND** constructing AppServerHost SHALL NOT implicitly create Pi resources
