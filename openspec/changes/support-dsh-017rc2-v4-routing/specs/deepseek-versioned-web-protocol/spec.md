## MODIFIED Requirements

### Requirement: DSH executable versions are selected by native format validation

The Adapter MUST use a single-line normative SemVer from --version to select a protocol profile, not as proof of compatibility. The 0.1.2 family MUST select V0. Modern versions below 0.1.7-rc.1 MUST select V3. SemVer versions greater than or equal to 0.1.7-rc.1 MUST select the V4 profile. Every selected profile MUST still pass native Remote, history, stream, and operation validation before readiness. Only versions with a completed real lifecycle Gate may be listed as verified.

#### Scenario: DSH 0.1.7-rc.2 selects V4

- WHEN --version returns 0.1.7-rc.2
- THEN the Adapter SHALL try the existing V4 profile
- AND valid V4 history and Remote data SHALL not be rejected as V3

#### Scenario: A later DSH version selects the forward V4 family

- WHEN --version returns a normative SemVer greater than or equal to 0.1.7-rc.1
- THEN the Adapter SHALL try the V4 profile without requiring a source-code version-list edit
- AND native protocol validation SHALL remain the compatibility gate

#### Scenario: A prerelease below the V4 boundary remains V3

- WHEN --version returns 0.1.7-rc.0 or another normative SemVer below 0.1.7-rc.1
- THEN the Adapter SHALL select V3 and SHALL NOT admit V4-only events through that profile

#### Scenario: A newer version fails V4 protocol validation

- WHEN a newer SemVer selects V4 but its Web history header or required events are not V4-compatible
- THEN the Adapter SHALL fail with a protocol error
- AND it SHALL NOT report the version as verified merely because SemVer comparison succeeded
