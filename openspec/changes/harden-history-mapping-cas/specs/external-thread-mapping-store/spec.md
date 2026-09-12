## MODIFIED Requirements

### Requirement: Ready Session replacement is one atomic identity update

Mapping Store SHALL support replacing a ready derived Thread's NativeSessionRef, complete retained Turn mapping set, and Fork source boundary in one validated atomic write. The replacement SHALL preserve the Host Thread ID and supplied retained Host Turn IDs, release the old Native indexes only after durable replacement, and leave the prior record and indexes authoritative on failure. Both Fork-derived and last-Turn replacement MUST require the expected target record Revision and complete source NativeSessionRef, including locator and format version, and MUST compare them with the current record inside the serialized update before writing. Host MUST retain the record used to prepare the replacement across asynchronous native work rather than substituting a newer Runtime record at commit time.

#### Scenario: Post-Fork rollback replacement succeeds

- **WHEN** Host commits an exact shorter derived Snapshot for an existing ready Thread whose Revision and NativeSessionRef still match the preparation record
- **THEN** restart SHALL recover only the final Native Session identity, retained Turn mappings, and selected Fork source boundary
- **AND** no retained mapping SHALL refer to the temporary Native Session

#### Scenario: Post-Fork rollback replacement fails

- **WHEN** temp write, sync, backup, or atomic replacement fails during ready Session replacement
- **THEN** the prior ready Native Session, full mapping set, Fork source, and indexes SHALL remain authoritative

#### Scenario: A queued update makes history replacement stale

- **WHEN** a queued metadata or configuration update changes the target Revision before a history replacement reaches its serialized update
- **THEN** the replacement SHALL fail with `MAPPING_CONFLICT` even if the retained Host Turn prefix still matches
- **AND** the newer durable record, in-memory record, Revision and indexes SHALL remain unchanged

#### Scenario: Expected Native Session reference does not match

- **WHEN** the expected source NativeSessionRef differs from the current reference, including its locator or format version, even with a matching expected Revision
- **THEN** either replacement operation SHALL reject the write as `MAPPING_CONFLICT`
- **AND** it SHALL preserve the authoritative record and indexes

#### Scenario: Runtime record changes while the native candidate is prepared

- **WHEN** native rollback or Fork preparation awaits and the loaded target record is updated
- **THEN** Host SHALL commit using the original target record expectation
- **AND** the Store SHALL reject the stale replacement instead of accepting the newer Runtime Revision as its preparation baseline

#### Scenario: Existing same-identity last-Turn rollback succeeds

- **WHEN** a last-Turn replacement retains the same Native Session identity, has the required shorter Host Turn prefix, and matches the expected Revision and source reference
- **THEN** Mapping Store SHALL continue to accept it without requiring a new Adapter capability or persisted format
