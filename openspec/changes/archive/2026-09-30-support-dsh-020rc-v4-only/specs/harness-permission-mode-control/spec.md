## MODIFIED Requirements

### Requirement: Permission Mode capability is structural and provider-owned

A `HarnessAdapter` MAY expose a strict browser-safe Permission Mode catalog together with `configuration.selectPermissionMode=true`. Mode IDs SHALL remain opaque outside the owning Adapter. An Adapter without a native selectable mode SHALL report the capability as false and SHALL NOT publish a catalog.

#### Scenario: Claude exposes native modes

- **WHEN** Claude inspection confirms the official SDK Permission Mode setter
- **THEN** it SHALL return its normalized provider-native catalog and `selectPermissionMode=true`
- **AND** no Claude SDK enum or settings payload SHALL cross the Adapter boundary

#### Scenario: DeepSeek exposes dynamic native presets

- **WHEN** DeepSeek Harness inspection finds a valid V4 `permissionPresets/catalog` value
- **THEN** it SHALL derive the Permission Mode IDs, order, labels, and default from the catalog's options and default
- **AND** codexhost SHALL NOT hardcode the deployment's preset catalog

#### Scenario: Pi has no native Permission Mode

- **WHEN** Pi is inspected or opened
- **THEN** it SHALL report `selectPermissionMode=false`, omit the catalog, and reject `permissionMode.select` as unsupported
