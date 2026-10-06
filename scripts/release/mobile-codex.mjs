import { execFile, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sha256File } from "./node-runtime.mjs";

export const MOBILE_CODEX_PATHS = [
  "bin/codex",
  "bin/codex-code-mode-host",
  "codex-path/rg",
  "codex-resources/zsh/bin/zsh",
  "codex-package.json",
  "manifest.json",
  "LICENSE",
  "NOTICE",
  "source.json",
  "changes.patch",
].map((name) => `app/mobile-codex/${name}`);
export function supportsMobileCodex(target) {
  return target.id === "macos-arm64";
}
/** Explicit opt-in: ordinary releases must not require rebuilding the Codex toolchain. */
export function packageMobileCodex(target, environment = process.env) {
  return supportsMobileCodex(target) && environment.CODEXHOST_BUILD_MOBILE_CODEX === "1";
}
async function run(command, args, cwd, environment = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)),
    );
  });
}

/** Build only at development/release time, from a verified upstream archive and reviewed patch. */
export async function buildMobileCodex({
  root,
  target,
  profile = "release",
  environment = process.env,
}) {
  if (!supportsMobileCodex(target)) return undefined;
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Mobile Codex requires a macOS arm64 build host");
  if (!["dev", "release"].includes(profile))
    throw new Error("Unsupported mobile Codex build profile");
  const patches = path.join(root, "tools/mobile-remote/patches");
  const source = JSON.parse(await readFile(path.join(patches, "source.json"), "utf8"));
  const patch = path.join(patches, "codex-0.160.0-remote-host.patch");
  if ((await sha256File(patch)) !== source.patchSha256)
    throw new Error("Mobile Codex patch digest mismatch");
  const cache = path.join(root, "build/mobile-codex", target.id);
  await mkdir(cache, { recursive: true });
  const archive = path.join(cache, `${source.commit}.tar.gz`);
  let missingArchive = false;
  try {
    await stat(archive);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    missingArchive = true;
  }
  if (missingArchive) {
    const response = await fetch(
      `https://codeload.github.com/openai/codex/tar.gz/${source.commit}`,
    );
    if (!response.ok) throw new Error(`Codex source download failed: ${response.status}`);
    const temporary = `${archive}.download-${process.pid}`;
    try {
      await writeFile(temporary, Buffer.from(await response.arrayBuffer()), { flag: "wx" });
      if ((await sha256File(temporary)) !== source.archiveSha256)
        throw new Error("Mobile Codex source digest mismatch");
      await rename(temporary, archive);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  if ((await sha256File(archive)) !== source.archiveSha256)
    throw new Error("Mobile Codex source digest mismatch");
  const sourceDirectory = path.join(cache, `source-${source.patchSha256}`);
  // Fresh extraction ensures untracked edits cannot enter a release; Cargo cache is separate.
  await rm(sourceDirectory, { recursive: true, force: true });
  await mkdir(sourceDirectory);
  await run("tar", ["-xzf", archive, "--strip-components=1", "-C", sourceDirectory], root);
  const rust = path.join(sourceDirectory, "codex-rs");
  await run("patch", ["-p1", "--batch", "-i", patch], rust);
  const cargoTarget = path.join(cache, "target");
  // The upstream code-mode runtime needs Codex's sandbox-enabled V8 build.
  // Its own package helper verifies the release manifest against this pinned
  // checkout, then verifies both the archive and generated Rust bindings.
  const { stdout } = await promisify(execFile)(
    "python3",
    [
      "-c",
      [
        "import json, sys",
        "from pathlib import Path",
        "sys.path.insert(0, 'scripts')",
        "from codex_package.targets import TARGET_SPECS",
        "from codex_package.v8 import fetch_codex_v8_artifacts",
        "v = fetch_codex_v8_artifacts(TARGET_SPECS['aarch64-apple-darwin'], cache_root=Path(sys.argv[1]))",
        "print(json.dumps({'RUSTY_V8_ARCHIVE': str(v.archive), 'RUSTY_V8_SRC_BINDING_PATH': str(v.binding)}))",
      ].join("\n"),
      path.join(cache, "v8"),
    ],
    {
      cwd: sourceDirectory,
      env: { ...environment, CODEX_REPO_ROOT: sourceDirectory },
      timeout: 600000,
      maxBuffer: 16384,
    },
  );
  const v8Environment = JSON.parse(stdout);

  await run(
    "cargo",
    [
      "build",
      "--locked",
      "--package",
      "codex-cli",
      "--bin",
      "codex",
      "--package",
      "codex-code-mode-host",
      "--bin",
      "codex-code-mode-host",
      ...(profile === "release" ? ["--release"] : []),
      "--jobs",
      "4",
    ],
    rust,
    { ...environment, ...v8Environment, CARGO_TARGET_DIR: cargoTarget },
  );
  return {
    binary: path.join(cargoTarget, profile === "release" ? "release" : "debug", "codex"),
    codeModeHost: path.join(
      cargoTarget,
      profile === "release" ? "release" : "debug",
      "codex-code-mode-host",
    ),
    sourceDirectory,
    source,
    patch,
    profile,
  };
}

export async function installMobileCodex({ artifact, outputDirectory }) {
  // Preserve the upstream install context, including its pinned shell and search resources.
  await run(
    "python3",
    [
      "scripts/build_codex_package.py",
      "--target",
      "aarch64-apple-darwin",
      "--variant",
      "codex",
      "--package-version",
      artifact.source.tag.replace("rust-v", ""),
      "--package-dir",
      outputDirectory,
      "--entrypoint-bin",
      artifact.binary,
      "--code-mode-host-bin",
      artifact.codeModeHost,
      "--force",
    ],
    artifact.sourceDirectory,
    { ...process.env, CODEX_REPO_ROOT: artifact.sourceDirectory },
  );
  const files = {};
  for (const name of [
    "bin/codex",
    "bin/codex-code-mode-host",
    "codex-path/rg",
    "codex-resources/zsh/bin/zsh",
    "codex-package.json",
  ]) {
    const output = path.join(outputDirectory, name);
    if (name !== "codex-package.json") {
      await chmod(output, 0o755);
      await run("/usr/bin/codesign", ["--force", "--sign", "-", output], outputDirectory);
    }
    files[name] = await sha256File(output);
  }
  for (const name of ["LICENSE", "NOTICE"])
    await copyFile(path.join(artifact.sourceDirectory, name), path.join(outputDirectory, name));
  await copyFile(artifact.patch, path.join(outputDirectory, "changes.patch"));
  await writeFile(
    path.join(outputDirectory, "source.json"),
    JSON.stringify(artifact.source, null, 2) + "\n",
  );
  await writeFile(
    path.join(outputDirectory, "manifest.json"),
    JSON.stringify(
      {
        version: artifact.source.tag.replace("rust-v", ""),
        platform: "darwin",
        architecture: "arm64",
        files,
        profile: artifact.profile,
      },
      null,
      2,
    ) + "\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, "../..");
  const artifact = await buildMobileCodex({
    root,
    target: { id: "macos-arm64" },
    profile: process.argv.includes("--dev") ? "dev" : "release",
  });
  await installMobileCodex({
    artifact,
    outputDirectory: path.join(root, "packages/host-runtime/dist/mobile-codex"),
  });
}
