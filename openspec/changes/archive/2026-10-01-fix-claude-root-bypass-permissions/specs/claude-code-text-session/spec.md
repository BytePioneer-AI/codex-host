## MODIFIED Requirements

### Requirement: Claude exposes the reviewed native Permission Modes

Claude Adapter SHALL expose `plan`, `default`, `acceptEdits`, and `bypassPermissions` with provider-native semantics. It SHALL expose `auto` only when at least one inspected native Model explicitly reports `supportsAutoMode=true`, SHALL NOT infer Auto support from setter presence or a custom Provider, and SHALL NOT expose `dontAsk` in the current catalog. Query creation SHALL keep `settingSources: ["user"]` and pass the selected Session mode. Bypass availability SHALL follow Claude Code's native startup rule for the environment actually passed to Claude Code: it is unavailable only when the process runs as root on a platform with `getuid`, `IS_SANDBOX` is not exactly `1`, and `CLAUDE_CODE_BUBBLEWRAP` is not a native truthy value. When available, Query creation SHALL set `allowDangerouslySkipPermissions: true` only as the SDK prerequisite for an explicit later bypass selection. When unavailable, the Adapter SHALL NOT pass that prerequisite, SHALL omit `bypassPermissions` from the catalog, and SHALL NOT start Claude Code in `bypassPermissions`. The Adapter SHALL NOT set `IS_SANDBOX` or otherwise declare a sandbox on the user's behalf.

#### Scenario: First Turn uses the selected Permission Mode

- **WHEN** create input carries a valid Claude mode
- **THEN** the lazy Query SHALL initialize with that exact mode and publish the native effective mode in complete Session state before `turn.started`

#### Scenario: Custom Model does not declare Auto support

- **WHEN** every inspected native Model omits or denies `supportsAutoMode`
- **THEN** the normalized catalog SHALL omit `auto` while retaining the other native modes and selection capability

#### Scenario: Bypass capability is enabled but not selected

- **WHEN** the Query is created in any non-bypass mode
- **THEN** the dangerous SDK prerequisite SHALL NOT itself select bypass, add a rule, change Sandbox, or suppress an ordinary Approval callback

#### Scenario: Root declares a deliberate sandbox

- **WHEN** Claude Code runs as root and the Session environment sets `IS_SANDBOX=1` or a truthy `CLAUDE_CODE_BUBBLEWRAP`
- **THEN** the catalog SHALL include `bypassPermissions`
- **AND** Query creation SHALL pass the dangerous SDK prerequisite so a later live bypass selection can succeed

#### Scenario: Root has no declared sandbox

- **WHEN** Claude Code runs as root without a declared sandbox
- **THEN** Query creation SHALL NOT pass the dangerous SDK prerequisite and the catalog SHALL omit `bypassPermissions`
- **AND** an explicit create, or a selection after Claude Code has started, of `bypassPermissions` SHALL return non-retryable `unsupported` naming `IS_SANDBOX=1` without starting or changing Claude Code

#### Scenario: Restored Session was saved in bypass permissions

- **WHEN** a resume or rollback input, or a selection made before Claude Code starts, restores `bypassPermissions` in an environment where it is unavailable
- **THEN** the Adapter SHALL keep the Session in `default`, report `default` as the effective mode, and start Claude Code in `default` instead of making it exit at startup
- **AND** the restored Thread SHALL remain openable and usable

#### Scenario: Claude Code rejects a live bypass selection

- **WHEN** the native setter rejects `bypassPermissions` because the Query was not launched with the prerequisite, or because settings or organization policy disable bypass
- **THEN** the Adapter SHALL return a non-retryable `nativeFailure` naming that reason and keep the current native mode
- **AND** any other native rejection SHALL keep the generic retryable Permission Mode failure

#### Scenario: SDK reports a catalog mode change

- **WHEN** a supported native init or status message reports a different catalog mode
- **THEN** Claude Adapter SHALL update the current Session mode through the ordered state stream
- **AND** a native mode outside the exposed catalog SHALL not fault the Session
