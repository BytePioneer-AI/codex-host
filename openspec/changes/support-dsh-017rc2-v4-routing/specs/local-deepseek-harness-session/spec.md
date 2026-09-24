## MODIFIED Requirements

### Requirement: Local DSH Web profile is the runtime source of truth

The DeepSeek Harness Adapter SHALL use a managed authenticated loopback Web Remote started from the user's local DSH Web profile. The 0.1.5-rc.3 V3 and 0.1.7-rc.1 V4 releases remain the verified Gate entries. Normative SemVer runtimes below 0.1.7-rc.1 use V3, and runtimes at or above 0.1.7-rc.1 may attempt V4; every unverified runtime MUST pass the selected native protocol checks before being reported ready and MUST NOT be described as verified without a real lifecycle Gate.

#### Scenario: DSH rc2 is tried as V4 without a false verification claim

- WHEN the local executable reports 0.1.7-rc.2
- THEN codexhost SHALL select V4 and validate the managed Web Remote and native history
- AND documentation SHALL distinguish this protocol route from completed real lifecycle evidence
