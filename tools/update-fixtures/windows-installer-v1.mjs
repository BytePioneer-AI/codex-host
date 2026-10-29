// Windows-only opt-in test materials; never publishes or changes working-tree versions.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, realpath, readFile, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { prepareReleasePayload } from "../../scripts/release/prepare-payload.mjs";
import { RELEASE_TARGETS } from "../../scripts/release/targets.mjs";
import {
  writeInstallerManifest,
  writeInstallerSidecar,
  fileDigest,
} from "../../scripts/release/windows/manifest.mjs";
import { linkFixtureDependencies, auditFixturePayload } from "./fixture-workspace.mjs";
const execute = promisify(execFile);
export async function buildV1Fixture(repository, manifest) {
  if (
    process.platform !== "win32" ||
    process.env.CODEXHOST_DISPOSABLE_WINDOWS_USER !== "fixture-only" ||
    !process.env.RUNNER_TEMP
  )
    throw new Error("Requires authorized disposable Windows x64 runner");
  if (process.arch !== "x64") throw new Error("ARM64 requires separate native evidence");
  const scratch = await realpath(process.env.RUNNER_TEMP);
  const root = path.join(scratch, `codexhost-inno-build-${Date.now()}`);
  await mkdir(root);
  const { stdout } = await execute(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repository, maxBuffer: 16 * 1024 * 1024 },
  );
  const names = [...new Set(stdout.split("\0").filter(Boolean))];
  const sharedTarget = path.join(root, "cargo-target");
  await mkdir(sharedTarget);
  const results = [];
  for (const [index, version] of ["99.0.1", "99.0.2"].entries()) {
    const source = path.join(root, `source-${index}`);
    await mkdir(source);
    for (const name of names) {
      await mkdir(path.dirname(path.join(source, name)), { recursive: true });
      await cp(path.join(repository, name), path.join(source, name));
    }
    const workspaces = await linkFixtureDependencies(repository, source, names);
    await symlink(sharedTarget, path.join(source, "target"), "junction");
    const versioning = await execute(
      process.execPath,
      [path.join(source, "scripts/release/prepare-version.mjs"), version],
      { cwd: source, maxBuffer: 16 * 1024 * 1024 },
    );
    process.stdout.write(versioning.stdout);
    const previousTarget = process.env.CARGO_TARGET_DIR;
    process.env.CARGO_TARGET_DIR = sharedTarget;
    let prepared;
    try {
      prepared = await prepareReleasePayload({
        target: RELEASE_TARGETS["windows-x64"],
        root: source,
      });
    } finally {
      if (previousTarget === undefined) delete process.env.CARGO_TARGET_DIR;
      else process.env.CARGO_TARGET_DIR = previousTarget;
    }
    await auditFixturePayload(source, prepared.payloadRoot, workspaces);
    if (index === 1) {
      // This file enters the NEXT installer [Files] table and generated ownership
      // manifest before ISCC; it is not a post-install injection or published asset.
      const introduced = path.join(
        prepared.payloadRoot,
        "app/plugins/fixture-next-only/owned-software.txt",
      );
      await mkdir(path.dirname(introduced), { recursive: true });
      await writeFile(introduced, "software owned by the next fixture installer\n");
    }
    await writeInstallerManifest(prepared.payloadRoot, version, "windows-x64");
    const binaryVersion = await execute(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-Item -LiteralPath $env:FIXTURE_LAUNCHER).VersionInfo.ProductVersion",
      ],
      {
        env: {
          ...process.env,
          FIXTURE_LAUNCHER: path.join(prepared.payloadRoot, "bin/codexhost.exe"),
        },
        maxBuffer: 4096,
      },
    );
    if (![version, `${version}.0`].includes(binaryVersion.stdout.trim()))
      throw new Error("Launcher binary and Runtime payload versions differ");
    const exe = path.join(root, `codexhost-${version}-windows-x64.exe`);
    const result = await execute(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        path.join(repository, "scripts/release/windows/package.ps1"),
        "-PayloadRoot",
        prepared.payloadRoot,
        "-OutputPath",
        exe,
        "-Version",
        version,
        "-Architecture",
        "x64",
      ],
      { cwd: repository, maxBuffer: 32 * 1024 * 1024 },
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    await writeInstallerSidecar(exe, prepared.payloadRoot);
    results.push({ path: exe, version, sha256: await fileDigest(exe) });
    const metadata = JSON.parse(
      await readFile(path.join(prepared.payloadRoot, "app/codexhost-distribution.json"), "utf8"),
    );
    if (metadata.version !== version) throw new Error("Fixture version mismatch");
  }
  const config = {
    previous: results[0],
    next: results[1],
    root: path.join(scratch, `codexhost-inno-v1-中文 空格-${Date.now()}`),
  };
  await writeFile(manifest, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
  return config;
}
