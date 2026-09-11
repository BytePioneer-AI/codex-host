## ADDED Requirements

### Requirement: The Vault SHALL preserve complete native credentials securely
One atomic Vault SHALL store metadata, committed current and encrypted inactive credentials. The permanent native file SHALL remain authoritative for current credentials. AES-256-GCM associated data SHALL bind format, canonical home, Account identity and digest. Existing Vaults without an available OS key MUST NOT receive a replacement key or plaintext fallback. Native bytes and unknown fields SHALL be preserved.

#### Scenario: Current native credentials rotate
- **WHEN** an owned backend refreshes its credentials before confirmed stop
- **THEN** the transaction SHALL preserve the final native bytes rather than an earlier cached snapshot

#### Scenario: An existing Vault's key cannot be obtained
- **WHEN** the OS key for an existing Vault is unavailable
- **THEN** managed credential operations SHALL fail closed without decrypting the Vault or creating a replacement key
- **AND** clean native fallback MAY retain file/process ownership solely for native single-account operation and process witnesses

#### Scenario: The file lease becomes unavailable
- **WHEN** the leased helper loses its stable file identity
- **THEN** all shared file facades SHALL stop issuing writes
- **AND** Rust primitives SHALL remain generic file/key/process capabilities without Account or OAuth semantics

### Requirement: One transaction executor SHALL recover from durable facts
Switch, first activation, current re-login and logout SHALL share one native credential transaction. Journal source/target and before/after Vault, actual credential identity/digest and operation receipts SHALL determine recovery. Durable commit followed by a lost acknowledgement or cleanup error MUST NOT roll back current. Compensation SHALL first preserve any latest target grant durably.

#### Scenario: Installed first login crashes before commit
- **WHEN** a Journal proves installation but current is still null
- **THEN** recovery SHALL interpret that operation before automatic native credential import

#### Scenario: Same-current re-login has rotated
- **WHEN** new authorization is installed and rotates before an error
- **THEN** recovery SHALL not restore the older authorization or replay a stale staged candidate

#### Scenario: Unknown native identity is observed
- **WHEN** actual credentials cannot be explained by the Vault and Journal
- **THEN** Host SHALL preserve evidence and reject the transition without first starting a writer that could refresh the unknown credentials

### Requirement: Login SHALL isolate staging and report saved state accurately
Login SHALL register one short-lived operation and use a private authentication-only home. Permanent and staging processes MUST NOT overlap. A current A SHALL remain A after Settings adds B. A native Desktop login SHALL instead retain the native intent to activate its signed-in identity. First successful login with no current Account SHALL activate through the common transaction. Completion and cancellation SHALL be associated with the operation and native login identity, not only a provisional Account ID.

#### Scenario: Login start races cancellation or an early event
- **WHEN** cancellation or completion arrives before start registration finishes, including after admission but before stage creation
- **THEN** the operation SHALL settle once, wait for start/stop facts and prevent late writes to the permanent home
- **AND** cancellation and terminal manager close SHALL recognize the already published operation ID before a stage object exists

#### Scenario: First login stops between saving its candidate and activation
- **WHEN** the first verified candidate is saved but activation has not committed
- **THEN** its durable stage SHALL remain until activation completes so restart or recover can finish the same operation
- **AND** activation failure with a stopped permanent backend SHALL report unavailable rather than ready

#### Scenario: Native login saves B before activation fails
- **WHEN** native login has saved B while A is current but activation has not completed
- **THEN** its durable stage SHALL retain the activate-on-success intent through restart or recovery
- **AND** recovery SHALL activate B through the same transaction instead of treating the operation as Settings-only addition
- **AND** a native completion SHALL NOT report authentication success while permanent readiness or cleanup remains unconfirmed

#### Scenario: Completion precedes the login start response
- **WHEN** the UI receives a completion before the matching start response, possibly with a deduplicated Account ID
- **THEN** it SHALL reconcile by loginId and SHALL NOT infer success from an existing Account email
- **AND** an ended operation with no received completion SHALL be shown as result-unconfirmed rather than an invented success

#### Scenario: Adding B succeeds but restoring A fails
- **WHEN** B is committed and A's restart or staging cleanup fails
- **THEN** the result SHALL report B saved and recovery required
- **AND** any newly refreshed A credentials SHALL remain authoritative

### Requirement: Inactive quota refresh SHALL not install credentials or lose concurrent data
Inactive quota reads SHALL use bounded requests without starting another backend. OAuth refresh SHALL use single-flight, exclusive change admission, identity verification and latest-Vault CAS. Cache retries SHALL reapply only the affected Account patch and retain last-good values rather than invent zero usage. Only current SHALL consume reset credits, without automatic retry.

#### Scenario: Two Accounts update during a cache conflict
- **WHEN** one cache write observes a newer persisted snapshot
- **THEN** retry SHALL merge its own Account change with that snapshot rather than overwrite another Account's update

### Requirement: Unsupported old layouts SHALL block without losing history
Only verified layouts SHALL be adopted. Single permanent-home adoption SHALL not copy or delete native history. Until complete multi-home migration exists, multiple or foreign homes, invalid metadata and orphan Thread bindings SHALL block Codex enablement. A future migration MUST preserve databases, attachments, memories, queues, projects and native relationships, require approved human confirmation before irreversible actions, and retain source data.

#### Scenario: Multiple old homes contain history
- **WHEN** startup detects that unsupported layout
- **THEN** it SHALL return migration-required, preserve all source homes and avoid both rollout-only migration and an old multi-backend fallback
- **AND** it SHALL not claim the migration or release acceptance has completed
