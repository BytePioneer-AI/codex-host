## Context

The V4 implementation already exists as DEEPSEEK_V017_PROFILE. DSH dsh-v0.1.7-rc.2 is tagged at 477b4f420553e8a52c2fbccc464d7561b239c443; its Session writer remains format V4. The selector is the only boundary that incorrectly treats 0.1.7-rc.2 as V3.

## Decisions

### Use one SemVer boundary

Parse the executable's already validated SemVer and compare it using normal SemVer precedence against 0.1.7-rc.1. This makes 0.1.7-rc.2, 0.1.7, later 0.1.x, and higher releases select the existing V4 profile without a version-specific list.

Prereleases below 0.1.7-rc.1 remain V3. The 0.1.2 family keeps its existing V0 rule and is evaluated first.

### Keep protocol validation authoritative

The version only selects which parser to try. Header, event, stream, Remote, Fork, and lifecycle checks remain authoritative. A newer version that does not actually speak the V4 protocol fails with the existing protocol error; it is not reported as verified merely because its version is newer.

### Reuse the existing V4 profile

The selector returns DEEPSEEK_V017_PROFILE and changes only its version label for later releases. No duplicate rc2 profile or transport branch is added.

## Validation

Run the focused V4 profile tests, TypeScript build/typecheck, formatting/lint checks, OpenSpec strict validation, and git diff --check. Do not claim a real DSH rc2 lifecycle Gate unless it is separately executed.
