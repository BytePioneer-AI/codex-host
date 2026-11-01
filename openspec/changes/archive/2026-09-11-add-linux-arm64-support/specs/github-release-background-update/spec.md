## ADDED Requirements

### Requirement: ARM64 Linux npm distributions SHALL use npm updates
Strict distribution metadata SHALL accept `linux-arm64`, SHALL require it to match a running `linux/arm64` host, and SHALL resolve its installed update context through the existing npm update path. It MUST NOT select or require a GitHub Release installer asset for Linux.

#### Scenario: ARM64 Linux npm installation checks for updates
- **WHEN** packaged metadata identifies distribution `npm` and target `linux-arm64` on a `linux/arm64` host
- **THEN** Host resolves the verified npm package paths and reports npm installation availability
- **AND** update preparation uses exact-version npm installation
- **AND** no DMG, EXE, `.deb`, or `.rpm` installer asset is selected
