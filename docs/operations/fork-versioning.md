# Fork versioning (`karlorz/codex-host`)

This checkout tracks [BytePioneer-AI/codex-host](https://github.com/BytePioneer-AI/codex-host) as `upstream` and publishes only to the fork [karlorz/codex-host](https://github.com/karlorz/codex-host). It does not define upstream BytePioneer release policy.

Package identity follows the same fork-scope rule as other karlorz forks: a permanent `@karlorz/` rename, not a publish-time override, and not `@codexhost/*`.

## Preserve Live Voice when syncing upstream

This is the operational runbook for upstream syncs. Preserve fork patches, merge
upstream on a branch from fork `main`, then verify the fork behavior and Desktop
pins separately. The fork's [Live Voice integration](cpa-live-voice-desktop-hook.md)
and [Grok Computer Use / IAB settings](../harnesses/grok/computer-use-settings.md)
remain fork responsibilities.

An upstream merge cannot by itself qualify Desktop voice. At the 22 October 2026
baseline (`origin/main` at `10ba06b7`), Work and Chat pins are **26.1013.40934**;
the reported Sparkle latest is **26.1016.61520** (fork issues
[#3](https://github.com/karlorz/codex-host/issues/3) and
[#4](https://github.com/karlorz/codex-host/issues/4)). The dirty Work overlay and
capability projection target **26.1016.61520** and are not part of that baseline.
Neither merging upstream nor changing a version string qualifies 26.1016.61520.
Recheck the live appcast and exact source pins at each sync.

### Protect the dirty tree and authorize the merge

Documentation updates can proceed independently. Before an actual merge, settle
both attended decisions: how to preserve dirty work, and whether to merge now.
The recommended preservation is a named backup branch with a WIP commit after
reviewing the file inventory; do not put an unreviewed bulk feature commit on
fork `main`. Merely creating a branch does not save dirty files.

1. Record `git status --short --branch`, the fork-main OID, staged changes and
   untracked files. Inventory the voice overlay/projection and IAB work as well
   as other local changes. Keep secrets, ignored build outputs and local
   environment files out of commits.
2. On the approved backup branch, explicitly stage the intended tracked and
   untracked source files and create the WIP snapshot. Record its branch and
   commit OID. Alternatively, park tracked and untracked work in an explicitly
   named `git stash push --include-untracked` entry, record its OID, and inspect
   its inventory. Verify that the recovery copy contains the intended files.
3. Return to fork `main` with a clean tracked/untracked source tree before
   creating the sync branch. Approved feature work may instead be reviewed and
   integrated into fork `main` first. Do not discard remaining dirty changes to
   make this precondition pass.
4. Obtain Karl's explicit **merge now** decision. A recommendation to document
   the process, silence, or a saved backup does not authorize the merge.

On a disk-constrained checkout, use Git snapshots and targeted asset reads. Do
not run Docker or extract the full Desktop ASAR. Run Rust validation only when
an approved merge affects Rust and the selected checks require it.

### Merge on a fork sync branch

Before an upstream sync:

1. Verify `origin` is `karlorz/codex-host` and `upstream` is
   `BytePioneer-AI/codex-host`, including push URLs. Fetch both. Compare fork
   `main` with `origin/main`; reconcile unexpected divergence before continuing.
   Record the fork and upstream OIDs used for this sync.
2. Create a uniquely named `sync/upstream-YYYY-MM-DD` branch from fork `main`,
   then merge the recorded `upstream/main` OID there. Never reset or replace fork
   `main` with upstream. A conflict-free merge still needs behavioral verification.
3. Resolve conflicts and inspect overlapping changes by responsibility. Do not
   apply a blanket choice of either side. Preserve the contracts below, or use
   an upstream implementation only after equivalent behavior is verified.
4. Restore the intended fork voice, overlay/projection and IAB changes from the
   backup, reviewed commits or stash as needed. For a stash, apply the saved OID
   and keep the recovery entry until verification finishes. Inspect each diff;
   do not blindly replay a mixed WIP snapshot or restore whole upstream files.
   Preserve fork package/update identity, `tools/compat-daily/`, the
   `compat:daily` / `compat:daily:test` scripts and
   `.github/workflows/compat-daily.yml`. IAB preferences must retain their real
   supported/unsupported binding semantics.

If resolution cannot preserve a contract, stop and record the unresolved
ownership or behavior. An in-progress merge can be aborted with `git merge --abort`
before applying saved WIP. Keep the backup/stash; do not use a destructive reset
on fork `main` as recovery.

### Required fork contracts

Required voice contracts:

- **Existing switches:** Console **Inject live-voice hook** (default on, relaunch)
  is the process-lifetime wrap. Desktop **Work voice** defaults to **Configured gateway**
  and **Chat voice** defaults to **ChatGPT**. Chat Instant Connect on
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
- **Rollout and scope:** Keep `model_provider = "custom"`. Do not globally
  override Statsig `3683713372`. Work capability/start projection must remain
  scoped to its audited owner and assets. Chat voice qualification for 26.1016
  stays deferred; preserve the existing qualified Chat path and fail closed on
  unqualified builds.
- **Gateway boundary:** Disabled-account selection and any future automatic
  quota retry belong to CPA. This fork's voice override does not implement
  account failover. Do not edit CPA core or deploy a gateway as part of a routine
  codex-host sync.

### Re-audit pins and verify the sync

Run `npm run compat:daily` from the candidate tree and record the report. This
fetches only the public Sparkle appcast, reads the local pins and exits nonzero
on drift; it neither updates pins nor qualifies Desktop behavior. Follow
[the compat-daily audit procedure](../../tools/compat-daily/README.md) to inspect
the exact assets/exports and change pins only with matching qualification
evidence. Keep Work and Chat qualification separate. Deferred Chat may continue
to report drift; record that limitation rather than changing its pin to make
the check green.

After resolving the sync, select checks for the actual merged diff using the
repository pre-push guidance. For voice changes, build the TypeScript packages
before dependent tests:

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
npm run compat:daily:test
npm run compat:daily
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

### Review and publish to the fork

Record the backup/stash OID, fork/upstream OIDs, candidate commit, Desktop
version/assets, checks and any deferred qualification in the wiki. Review the
sync diff and limitations before integrating it into fork `main`; keep the
recovery snapshot until the intended fork work is accounted for.

Prepare a local commit for review. Push only with explicit authorization, naming
the remote and branch, for example `git push origin sync/upstream-YYYY-MM-DD`.
Use `-R karlorz/codex-host` for any authorized PR. Never push to `upstream` or
force-push `main`. Integrating into fork `main`, releases and production changes
are separate authorized actions. This runbook does not install an automatic
sync guard or change branch protection.

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
