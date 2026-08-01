## ADDED Requirements

### Requirement: Settings presentation follows bounded Codex locale state
The Renderer Extension SHALL resolve settings presentation from a validated Codex `localeOverride` and automatic locale inputs through fixed method-specific operations. It SHALL provide owned English and Simplified Chinese messages for the settings trigger, shell controls, navigation, search, accessibility labels, foundation pages, language options, and errors. It MUST expose the selected owned locale through the settings Shadow host `lang` attribute and MUST NOT infer language from translated DOM text, private React state, or the Codex document `lang` attribute.

#### Scenario: User configured an explicit supported language
- **WHEN** the validated Codex locale override is an English or Chinese language tag
- **THEN** the settings trigger and shell SHALL use the corresponding owned English or Simplified Chinese catalog
- **AND** the settings Shadow host SHALL expose the corresponding owned locale

#### Scenario: Codex language is automatic
- **WHEN** the validated locale override is `null`
- **THEN** Renderer SHALL resolve the preferred locale from bounded Codex automatic locale inputs
- **AND** it SHALL use the matching owned catalog when English or Chinese is resolved

#### Scenario: Locale bridge or response is unavailable
- **WHEN** a fixed locale read times out, fails, or returns a malformed response
- **THEN** settings SHALL remain usable with a browser-language or English fallback
- **AND** Renderer SHALL NOT expose an arbitrary native request fallback or claim an explicit Codex override

#### Scenario: Codex uses an unsupported catalog language
- **WHEN** the validated preferred locale is neither English nor Chinese
- **THEN** settings SHALL render its English fallback catalog
- **AND** it SHALL preserve the unsupported Codex override as an honest non-writable current selection until the user chooses a supported option

### Requirement: Settings exposes a visible bounded language selector
The settings sidebar SHALL display an interface-language selector before search with Automatic, English, and Simplified Chinese choices. Automatic MUST write Codex `localeOverride` as `null`, English MUST write `en-US`, and Simplified Chinese MUST write `zh-CN` through one fixed method-specific locale operation. The selector MUST NOT expose an arbitrary setting key, locale value, URL, method, or payload.

#### Scenario: User chooses English or Simplified Chinese
- **WHEN** the user selects a supported explicit language and the bounded Codex setting write succeeds
- **THEN** the dialog SHALL remain open using the selected owned catalog
- **AND** the active settings page SHALL remain selected
- **AND** the selector SHALL expose the confirmed explicit language

#### Scenario: User chooses Automatic
- **WHEN** the user selects Automatic and the bounded Codex setting write succeeds
- **THEN** Renderer SHALL clear the explicit locale override with `null`
- **AND** the open dialog SHALL use the newly resolved automatic language without resetting its active page

#### Scenario: Language write is pending
- **WHEN** a bounded locale setting update has not settled
- **THEN** the selector SHALL be disabled until the operation completes or fails
- **AND** duplicate writes SHALL NOT be issued from that control

#### Scenario: Language write fails
- **WHEN** the fixed locale setting operation rejects, times out, or returns a malformed response
- **THEN** the selector SHALL restore its prior confirmed selection
- **AND** the shell SHALL show a localized accessible inline error
- **AND** the existing dialog language and active page SHALL remain usable

#### Scenario: Narrow settings window displays language control
- **WHEN** the settings dialog uses its narrow layout
- **THEN** the language selector SHALL remain visible without overlapping horizontal navigation, page content, or the close control
- **AND** it SHALL NOT introduce page-level horizontal overflow
