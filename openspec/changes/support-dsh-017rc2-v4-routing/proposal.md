## Why

DSH 0.1.7-rc.2 keeps the V4 Session journal, but the Adapter currently selects V4 only for the exact 0.1.7-rc.1 string. rc2 and later releases therefore enter the V3 profile and fail on valid V4 history.

## What Changes

- Select the existing V4 profile for SemVer versions greater than or equal to 0.1.7-rc.1.
- Keep 0.1.2 versions on V0 and older modern versions below the V4 boundary on V3.
- Add SemVer precedence regression coverage for rc2, stable releases, future prereleases, and versions below the boundary.
- Update the DSH protocol specifications and validation documentation to distinguish V4 routing from real lifecycle Gate evidence.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- deepseek-versioned-web-protocol: V4 profile selection is a forward-compatible SemVer family while native protocol validation remains the compatibility gate.
- deepseek-harness-fast-session: Modern DSH versions at or above the V4 boundary use the V4 profile.
- local-deepseek-harness-session: Future normative SemVer runtimes may attempt the V4 protocol without being listed as verified until a real Gate passes.

## Impact

The production change is confined to the DeepSeek profile selector and its tests. No new transport, profile, persistent format, public Host contract, dependency, or DSH source change is required.
