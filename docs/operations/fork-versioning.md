# Fork versioning (`karlorz/codex-host`)

This checkout tracks [BytePioneer-AI/codex-host](https://github.com/BytePioneer-AI/codex-host) as `upstream` and publishes only to the fork [karlorz/codex-host](https://github.com/karlorz/codex-host). It does not define upstream BytePioneer release policy.

Package identity follows the same fork-scope rule as other karlorz forks: a permanent `@karlorz/` rename, not a publish-time override, and not `@codexhost/*`.

## Tag rule

Fork versions stay on the **upstream version that is currently held**, plus a numeric fork counter.

| Upstream holds | First fork tag | Next fork tags |
| --- | --- | --- |
| `0.13.2` | `v0.13.2-0` | `v0.13.2-1`, `v0.13.2-2`, … |
| later `0.13.3` | `v0.13.3-0` | `v0.13.3-1`, … |

- Read upstream from `upstream/main` `package.json` and the upstream GitHub latest release. If they disagree, stop and report; do not guess.
- `n` is the next unused non-negative integer for that upstream version on the fork (`0` if none exist).
- Do **not** invent a newer minor or patch than upstream (for example `0.13.3-cpa.1` while upstream still holds `0.13.2`).
- `v0.13.2-0` is valid SemVer (prerelease `0` of `0.13.2`). Prepare it with `npm run release:prepare -- 0.13.2-0`.
- Numeric prerelease `0.13.2-0` compares **below** upstream `0.13.2`. The in-app updater and Settings command must therefore **not** read BytePioneer `releases/latest` or install `@codexhost/cli`. They use `karlorz/codex-host` and `@karlorz/codexhost-cli` instead.

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

1. **npm:** attended `npm publish` of the packed meta package and matching platform tarballs under the `@karlorz` scope, dist-tag `latest` (or `next` only if the tag is an npm prerelease channel). `scripts/release/publish-npm.mjs` fails closed if a plan entry is not `@karlorz/`.
2. **GitHub:** a **latest** (non-prerelease) Release on `karlorz/codex-host` for the same tag. The updater reads `/releases/latest` and rejects prereleases, so a prerelease-only fork Release leaves Updates empty or in error instead of offering the fork build.

The standard `Release packages` workflow classifies hyphenated SemVer tags as prereleases and publishes them with `--prerelease --latest=false`. An attended fork counter release must explicitly use non-prerelease GitHub Release status and become latest to appear in Updates; the numeric tag alone does not make it discoverable.

Keep GitHub Actions workflow `Release packages` **disabled** until it is wired to publish `@karlorz/*` with a Trusted Publisher on `karlorz/codex-host`. Do not enable it while it would still publish `@codexhost/*`. Do not `npm publish` `@codexhost/cli`. Local `npm run install:local` packs and installs tarballs without the registry.

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

Keep `Release packages` disabled until npm Trusted Publisher on `@karlorz/codexhost-cli` (and the six platform packages) is the karlorz GitHub repo.

## Release channel on this fork

- Never `git push` to `upstream`.
- Never publish `@codexhost/*` from this checkout.
- Do not move, delete, or re-push an existing tag unless the operator explicitly requested that rewrite.
- Create GitHub Releases with `-R karlorz/codex-host`. `gh release create --notes-from-tag` does not work with `--repo`; write the tag annotation to a notes file instead. A `gh` invocation without `-R` may resolve to BytePioneer and must abort.

## Next unused counter

```bash
git fetch upstream --tags --prune
git fetch origin --tags --prune
# example when upstream holds 0.13.2:
git ls-remote --tags origin 'refs/tags/v0.13.2-*'
```

Pick the smallest `n` that is not already a fork tag. Then `npm run release:prepare -- 0.13.2-<n>` on a branch, with the usual release-skill checks before any tag push.
