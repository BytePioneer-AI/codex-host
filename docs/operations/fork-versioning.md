# Fork versioning (`karlorz/codex-host`)

This checkout tracks [BytePioneer-AI/codex-host](https://github.com/BytePioneer-AI/codex-host) as `upstream` and publishes only to the fork [karlorz/codex-host](https://github.com/karlorz/codex-host). It does not define upstream BytePioneer release policy.

Package identity follows the same fork-scope rule as other karlorz forks: a permanent `@karlorz/` rename, not a publish-time override, and not `@codexhost/*`.

## Preserve Live Voice when syncing upstream

The fork's [Live Voice integration](cpa-live-voice-desktop-hook.md) is maintained
alongside upstream. Documentation records its contract; it does not enforce merge
resolution or guarantee compatibility with a new Desktop build.

Before an upstream sync:

1. Commit approved fork changes and integrate them into the fork's `main` before
   creating the sync branch. A feature branch running locally is not part of
   `main` until merged. Record the starting commit and keep a local backup branch.
2. Verify `origin` is `karlorz/codex-host` and `upstream` is
   `BytePioneer-AI/codex-host`. Fetch both, then merge upstream on a separate sync
   branch based on the fork's current main. Do not reset or replace fork main with
   upstream main. A conflict-free merge still needs behavioral verification.
3. Inspect conflicts and overlapping changes by responsibility. Do not apply a
   blanket choice of either side. Preserve the contracts below, or replace them
   with an upstream implementation only after equivalent behavior is verified.

Required voice contracts:

- **Existing switches:** Console **Inject live-voice hook** (default on, relaunch)
  is the process-lifetime wrap. Desktop **Work live voice (gateway)** defaults on
  and **Chat live voice (gateway)** defaults off. Chat Instant Connect on
  `https://chatgpt.com/realtime/wm` keeps
  Desktop ChatGPT login. Work uses Host → gateway. A disabled Work switch calls
  the original `/wham` WebFetch. The usage-warning switch does not route calls.
- **Native call creation:** On the audited client-owned Desktop flow,
  `renderer-client-owned-voice.ts` forwards the native call-create request through
  `codexhost/realtime/call` to `native-voice-gateway.ts`. Preserve the Host RPC
  dispatch, Renderer entry points, shared `realtime-call.ts` contracts and
  `realtime-gateway-config.ts`; gateway credentials stay in the Host, request
  headers remain allowlisted, and gateway failures do not fall back to Desktop
  OAuth.
- **CSP:** `production-controller.ts` sets Zod `jitless` before both the primary
  Renderer and overlay bundles are evaluated. Preserve strict CSP without adding
  `unsafe-eval`.
- **Lifecycle and Harness:** Preserve cancellation/hangup cleanup, external
  existing-call attachment without duplicate creation, and the selected Harness
  for new-chat launches. Official Codex realtime handling continues through its
  native app-server path.
- **Version boundary:** Preserve exact audited asset checks. After a Desktop
  update, re-audit its native exports and call ownership before enabling another
  build; a passing source merge does not qualify new Desktop assets.
- **Gateway boundary:** Disabled-account selection and any future automatic
  quota retry belong to CPA. This fork's voice override does not implement
  account failover. Do not edit CPA core or deploy a gateway as part of a routine
  codex-host sync.

After resolving the sync, build the TypeScript packages before dependent tests:

```bash
npm run build:typescript
npm run typecheck
npm run lint
npm run build:renderer
npx vitest run --config tests/vitest.config.js \
  packages/desktop-control/test/production-controller.test.ts \
  packages/shared-contracts/test/realtime-call.test.ts \
  packages/renderer-extension/test/renderer-client-owned-voice.test.ts \
  packages/renderer-extension/test/renderer-external-voice-launch.test.ts \
  packages/renderer-extension/test/renderer-cpa-live-voice-hook.test.ts \
  packages/renderer-extension/test/renderer-cpa-live-voice-preference.test.ts \
  packages/host-runtime/test/native-voice-gateway.test.ts \
  packages/host-runtime/test/external-voice-gateway.test.ts \
  packages/host-runtime/test/external-voice-lifecycle.test.ts \
  packages/host-runtime/test/app-server-host.external-voice.test.ts
npm run test:e2e -- renderer-voice-csp.spec.ts
git diff --check
```

The browser regression requires an installed Playwright browser. If using an
installed Chrome executable, set `CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH` for that
test command. Broaden checks for any additional packages or Rust code affected by
the sync; the voice set is not a substitute for those checks.

With restart and live testing authorized, use `npm start` to rebuild and launch
the sync result. Confirm the running overlay hook is active on audited assets,
call creation reaches the configured gateway, WebRTC connects, and hangup is
confirmed without CSP errors. Then verify native-button startup, audible output
and the selected Harness. A silent transport probe alone does not establish
microphone/conversation acceptance. Record the tested commit, Desktop version,
checks and remaining limitations in the wiki without credentials, SDP or call
identities.

Integrate the verified sync branch into fork main. Pushes, releases, upstream PRs
and production changes remain separate authorized actions. This checklist does
not install an automatic sync guard or change branch protection.

## Tag rule

Fork versions stay on the **upstream version that is currently held**, plus a numeric fork counter.

| Upstream holds | First fork tag | Later fork tags |
| --- | --- | --- |
| `0.13.2` | `v0.13.2-0` | `v0.13.2-1`, `v0.13.2-2`, `v0.13.2-3` |
| `0.13.3` | `v0.13.3-0` | `v0.13.3-1`, `v0.13.3-2`, … |

- Read upstream from `upstream/main` `package.json` and the upstream GitHub latest release. If they disagree, stop and report; do not guess.
- First fork of an upstream version is `X.Y.Z-0`. Later fork-only releases while that upstream version is still held are `X.Y.Z-1`, `X.Y.Z-2`, …. The shipped `0.13.2` tags already use that single-counter form.
- Do **not** invent a newer minor or patch than upstream, and do **not** add a named suffix such as `0.13.3-cpa.1`. That tag is legacy and is not a fork release channel.
- `v0.13.3-0` is valid SemVer (prerelease `0` of `0.13.3`). Prepare it with `npm run release:prepare -- 0.13.3-0`.
- Numeric prerelease `0.13.3-0` compares **below** upstream `0.13.3`. The in-app updater and Settings command must therefore **not** read BytePioneer `releases/latest` or install `@codexhost/cli`. They use `karlorz/codex-host` and `@karlorz/codexhost-cli` instead.

The four prepared files (`package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`) must equal that version. Packaged `app/codexhost-distribution.json` is written later by `release:package` / `release:npm`, not by `release:prepare`. The Web console overview **codexhost 版本** reads that distribution file (installer/npm) or workspace `package.json` (source). After prepare, rebuild or recopy the installed `codexhost-distribution.json` so the live console matches the tag.

## npm and in-app updates

Fork operators install and update with:

```bash
npm install -g @karlorz/codexhost-cli@latest
```

That is the Settings → Updates manual command. Settings auto-checks `karlorz/codex-host` `/releases/latest` when Updates is opened. A current version that already matches that latest tag is up to date. A higher fork counter is offered only after that version is published as the fork's non-draft, non-prerelease GitHub latest Release. **Update and restart** on an npm install then runs `@karlorz/codexhost-cli` at that GitHub latest version (via the Updater). Installation requires an explicit user action.

| Channel | Fork identity | Do not use |
| --- | --- | --- |
| npm meta package | `@karlorz/codexhost-cli` | `@codexhost/cli` |
| npm platform packages | `@karlorz/codexhost-cli-darwin-arm64` (and the other five) | `@codexhost/cli-*` |
| GitHub latest / notes / assets | `karlorz/codex-host` | `BytePioneer-AI/codex-host` |

A fork tag is not shipped until both of these exist for that version:

1. **npm:** `Release packages` publishes the packed meta package and matching platform tarballs under `@karlorz` with dist-tag `latest` (or `next` / `test` only for named SemVer prereleases). `scripts/release/publish-npm.mjs` fails closed if a plan entry is not `@karlorz/`. After CI logs `+ @karlorz/…@<version>`, npm may still 404 for a few minutes while provenance is processed; recurl the version URL before republishing.
2. **GitHub:** a **latest** (non-draft, non-prerelease) Release on `karlorz/codex-host` for the same tag. The updater reads `/releases/latest` and rejects prereleases, so a prerelease-only fork Release leaves Updates empty or in error instead of offering the fork build.

Numeric fork counters such as `0.13.3-0` and `0.13.3-1` are GitHub latest and npm `latest`. Named SemVer prereleases (`-rc.1`, `-beta.1`, `-test.1`, `-cpa.1`) stay on `next` / `test` and GitHub prerelease. `packages/repository-automation/src/release.mjs` treats a hyphen plus one or more digit groups (`0.13.3-0`, `0.13.3-1`) as latest, not as `next`. Do not `npm publish` `@codexhost/cli`. Local `npm run install:local` packs and installs tarballs without the registry.

Shipped latest on this fork is `v0.13.3-0`: GitHub latest plus `@karlorz/codexhost-cli@0.13.3-0` and all six platform packages on npm `latest`. The next unused counter while upstream holds `0.13.3` is `0.13.3-1`.

## GitHub Actions secrets

CI and `Release packages` already use the job `GITHUB_TOKEN` (`contents` / `id-token: write`). Do not add `secrets.NPM_TOKEN` or `NODE_AUTH_TOKEN` to those workflows: npm publish is Trusted Publisher (`id-token: write` + `--provenance`), same as upstream.

Store these repo secrets on `karlorz/codex-host` for attended and future fork-sync work, matching the other karlorz forks:

| Secret | Same as | Purpose |
| --- | --- | --- |
| `NPM_TOKEN` | `karlorz/llm-wiki` | Operator/local `npm publish` of `@karlorz/*` when OIDC is not in play. Not read by current CI YAML. |
| `FORK_SYNC_TOKEN` | `karlorz/orca` | Classic PAT with `repo` + `workflow`. Needed later for `merge-upstream` / pushing workflow-file updates; `GITHUB_TOKEN` cannot do that. `karlorz/cliproxyapi` names the same kind of PAT `UPSTREAM_SYNC_PUSH_TOKEN`. |

```bash
# npmjs auth token from ~/.npmrc, value never printed
python3 -c 'from pathlib import Path
for line in Path.home().joinpath(".npmrc").read_text().splitlines():
    if line.startswith("//registry.npmjs.org/:_authToken="):
        print(line.split("=",1)[1], end="")
        break
' | gh secret set NPM_TOKEN -R karlorz/codex-host

# classic PAT (repo + workflow), not a gh oauth gho_ token
gh secret set FORK_SYNC_TOKEN -R karlorz/codex-host
```

`Release packages` is enabled on `karlorz/codex-host`. npm Trusted Publisher for `@karlorz/codexhost-cli` and the six platform packages is this GitHub repo (`id-token: write` + `--provenance`). A tag push of a numeric fork counter on `main` after that SHA's CI is green is the ship path. Do not disable the workflow for a normal latest release.

## Release channel on this fork

- Never `git push` to `upstream`.
- Never publish `@codexhost/*` from this checkout.
- Do not move, delete, or re-push an existing tag unless the operator explicitly requested that rewrite.
- Create GitHub Releases and pull requests with `-R karlorz/codex-host`. Default `gh` in this checkout resolves to BytePioneer-AI/codex-host. `gh pr create` without `-R` opened the wrong-repo PR #547 and must abort. `gh release create --notes-from-tag` does not work with `--repo`; write the tag annotation to a notes file instead.
- After the lock is on `origin/main`, the next command is `npm run release:prepare -- 0.13.3-0` on `main`. Merge of an identity-lock PR is not a release.

## Next unused counter

```bash
git fetch upstream --tags --prune
git fetch origin --tags --prune
# example when upstream holds 0.13.3:
git ls-remote --tags origin 'refs/tags/v0.13.3-*'
```

Shipped tags include `v0.13.2-0` through `v0.13.2-3` and `v0.13.3-0`. After upstream `0.13.3`, later fork tags on the same upstream are `0.13.3-1`, `0.13.3-2`, …. Then `npm run release:prepare -- 0.13.3-1` on `main`, push the four version files, wait for that SHA's `main` push CI, then push the annotated tag.
