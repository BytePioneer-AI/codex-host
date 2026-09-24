## MODIFIED Requirements

### Requirement: DeepSeek Harness uses the shared Adapter contract

The system SHALL provide one public deepseek-harness implementation of HarnessAdapter and HarnessSession. It SHALL use V0 for the 0.1.2 family, V3 for modern SemVer versions below 0.1.7-rc.1, and the existing V4 profile for SemVer versions greater than or equal to 0.1.7-rc.1. Every runtime SHALL pass native protocol validation before being reported ready. DSH Remote methods, event names and version profiles MUST remain internal to the Adapter package.

#### Scenario: DSH rc2 opens through the V4 profile

- WHEN a 0.1.7-rc.2 runtime passes Web and native protocol checks
- THEN the Adapter SHALL return a standard HarnessSession using V4 history and checkpoint semantics
- AND the Adapter SHALL not require a duplicate rc2 transport or profile

#### Scenario: A future DSH runtime is protocol-incompatible

- WHEN a newer SemVer selects V4 but its native header or required events use another format
- THEN the Adapter SHALL fail with a protocol error and SHALL NOT report the Session as ready
