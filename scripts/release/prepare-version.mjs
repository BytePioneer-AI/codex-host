import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { validateReleaseVersion } from "../../packages/repository-automation/index.mjs";

export { validateReleaseVersion };

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);

export function parseReleasePrepareArguments(arguments_) {
  let version;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--version") {
      if (version !== undefined) throw new Error("release version may only be provided once");
      version = arguments_[++index];
      if (!version) throw new Error("--version requires a value");
      continue;
    }
    if (argument.startsWith("--version=")) {
      if (version !== undefined) throw new Error("release version may only be provided once");
      version = argument.slice("--version=".length);
      if (!version) throw new Error("--version requires a value");
      continue;
    }
    if (!argument.startsWith("-") && version === undefined) {
      version = argument;
      continue;
    }
    throw new Error(`unknown release prepare argument: ${argument}`);
  }
  if (!version) throw new Error("release version is required");
  return { help: false, version: validateReleaseVersion(version) };
}

function parseJson(source, fileName) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(
      `${fileName} is not valid JSON: ${error instanceof Error ? error.message : error}`,
      { cause: error },
    );
  }
}

function updateCargoSectionVersion(source, sectionHeader, version) {
  const escapedHeader = sectionHeader.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const header = new RegExp(`^${escapedHeader}[ \\t]*\\r?$`, "mu").exec(source);
  if (!header) throw new Error(`Cargo.toml must define ${sectionHeader}`);

  const bodyStart = header.index + header[0].length;
  const sectionPattern = /^\[[^\r\n]+\][ \t]*\r?$/gmu;
  sectionPattern.lastIndex = bodyStart;
  const nextSection = sectionPattern.exec(source);
  const bodyEnd = nextSection?.index ?? source.length;
  const body = source.slice(bodyStart, bodyEnd);
  const versionPattern = /^([ \t]*version[ \t]*=[ \t]*)"[^"\r\n]*"([ \t]*(?:#.*)?)$/gmu;
  const matches = [...body.matchAll(versionPattern)];
  if (matches.length !== 1) {
    throw new Error(`Cargo.toml ${sectionHeader} must define exactly one version`);
  }

  const match = matches[0];
  const versionStart = bodyStart + match.index;
  const replacement = `${match[1]}"${version}"${match[2]}`;
  return source.slice(0, versionStart) + replacement + source.slice(versionStart + match[0].length);
}

export function updateCargoWorkspaceVersion(source, version) {
  return updateCargoSectionVersion(source, "[workspace.package]", version);
}

export function updateCargoPackageVersion(source, version) {
  return updateCargoSectionVersion(source, "[package]", version);
}

export function updateCargoLockWorkspaceVersions(source, packageNames, version) {
  const packageHeaders = [...source.matchAll(/^\[\[package\]\][ \t]*\r?$/gmu)];
  const found = new Set();
  let result = source.slice(0, packageHeaders[0]?.index ?? source.length);

  for (let index = 0; index < packageHeaders.length; index += 1) {
    const blockStart = packageHeaders[index].index;
    const blockEnd = packageHeaders[index + 1]?.index ?? source.length;
    let block = source.slice(blockStart, blockEnd);
    const name = /^name[ \t]*=[ \t]*"([^"\r\n]+)"[ \t]*\r?$/mu.exec(block)?.[1];
    if (name && packageNames.has(name)) {
      const versionPattern = /^([ \t]*version[ \t]*=[ \t]*)"[^"\r\n]*"([ \t]*)$/gmu;
      const matches = [...block.matchAll(versionPattern)];
      if (matches.length !== 1) {
        throw new Error(`Cargo.lock package '${name}' must define exactly one version`);
      }
      block = block.replace(versionPattern, `$1"${version}"$2`);
      found.add(name);
    }
    result += block;
  }

  const missing = [...packageNames].filter((name) => !found.has(name));
  if (missing.length > 0) {
    throw new Error(`Cargo.lock is missing workspace packages: ${missing.join(", ")}`);
  }
  return result;
}

async function synchronizeCargoLock(root, version) {
  const { stdout } = await execFileAsync(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps"],
    {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const metadata = parseJson(stdout, "cargo metadata output");
  const workspaceMemberIds = new Set(metadata.workspace_members);
  const workspacePackageNames = new Set(
    metadata.packages
      .filter((candidate) => workspaceMemberIds.has(candidate.id))
      .map((candidate) => candidate.name),
  );
  if (workspacePackageNames.size === 0) {
    throw new Error("cargo metadata did not report any workspace packages");
  }

  const cargoLockPath = path.join(root, "Cargo.lock");
  const cargoLockSource = await readFile(cargoLockPath, "utf8");
  const nextCargoLockSource = updateCargoLockWorkspaceVersions(
    cargoLockSource,
    workspacePackageNames,
    version,
  );
  if (nextCargoLockSource !== cargoLockSource) {
    await writeFile(cargoLockPath, nextCargoLockSource, "utf8");
  }
  return workspacePackageNames;
}

const DESKTOP_SHELL_CARGO_TOML = "apps/desktop-shell/src-tauri/Cargo.toml";
const DESKTOP_SHELL_CARGO_LOCK = "apps/desktop-shell/src-tauri/Cargo.lock";
const DESKTOP_SHELL_TAURI_CONF = "apps/desktop-shell/src-tauri/tauri.conf.json";

function lockfilePackageNames(source) {
  const names = new Set();
  for (const match of source.matchAll(
    /^\[\[package\]\][ \t]*\r?\nname[ \t]*=[ \t]*"([^"\r\n]+)"/gmu,
  )) {
    names.add(match[1]);
  }
  return names;
}

export async function prepareReleaseVersion({ version, root = repositoryRoot }) {
  const releaseVersion = validateReleaseVersion(version);
  const packagePath = path.join(root, "package.json");
  const lockPath = path.join(root, "package-lock.json");
  const cargoManifestPath = path.join(root, "Cargo.toml");
  const cargoLockPath = path.join(root, "Cargo.lock");
  const shellCargoPath = path.join(root, DESKTOP_SHELL_CARGO_TOML);
  const shellLockPath = path.join(root, DESKTOP_SHELL_CARGO_LOCK);
  const shellTauriConfPath = path.join(root, DESKTOP_SHELL_TAURI_CONF);
  const hasDesktopShell = existsSync(shellCargoPath);

  const [
    packageSource,
    lockSource,
    cargoManifestSource,
    cargoLockSource,
    shellCargoSource,
    shellLockSource,
    shellTauriConfSource,
  ] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(lockPath, "utf8"),
    readFile(cargoManifestPath, "utf8"),
    readFile(cargoLockPath, "utf8"),
    hasDesktopShell ? readFile(shellCargoPath, "utf8") : Promise.resolve(null),
    hasDesktopShell ? readFile(shellLockPath, "utf8") : Promise.resolve(null),
    hasDesktopShell ? readFile(shellTauriConfPath, "utf8") : Promise.resolve(null),
  ]);
  const manifest = parseJson(packageSource, "package.json");
  const lockfile = parseJson(lockSource, "package-lock.json");

  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new Error("root package.json must define a package name");
  }
  if (lockfile.name !== manifest.name || lockfile.packages?.[""]?.name !== manifest.name) {
    throw new Error("package-lock.json root package name does not match package.json");
  }
  if (typeof lockfile.packages[""] !== "object" || lockfile.packages[""] === null) {
    throw new Error("package-lock.json must define the root package entry");
  }

  manifest.version = releaseVersion;
  lockfile.version = releaseVersion;
  lockfile.packages[""].version = releaseVersion;

  const nextPackageSource = `${JSON.stringify(manifest, null, 2)}\n`;
  const nextLockSource = `${JSON.stringify(lockfile, null, 2)}\n`;
  const nextCargoManifestSource = updateCargoWorkspaceVersion(cargoManifestSource, releaseVersion);

  let nextShellCargoSource = null;
  let nextShellTauriConfSource = null;
  if (hasDesktopShell) {
    nextShellCargoSource = updateCargoPackageVersion(shellCargoSource, releaseVersion);
    const tauriConf = parseJson(shellTauriConfSource, DESKTOP_SHELL_TAURI_CONF);
    tauriConf.version = releaseVersion;
    nextShellTauriConfSource = `${JSON.stringify(tauriConf, null, 2)}\n`;
  }

  try {
    await Promise.all([
      writeFile(packagePath, nextPackageSource, "utf8"),
      writeFile(lockPath, nextLockSource, "utf8"),
      writeFile(cargoManifestPath, nextCargoManifestSource, "utf8"),
      ...(hasDesktopShell
        ? [
            writeFile(shellCargoPath, nextShellCargoSource, "utf8"),
            writeFile(shellTauriConfPath, nextShellTauriConfSource, "utf8"),
          ]
        : []),
    ]);
    const workspacePackageNames = await synchronizeCargoLock(root, releaseVersion);
    if (hasDesktopShell) {
      const presentNames = lockfilePackageNames(shellLockSource);
      const shellLockTargetNames = new Set(["codexhost-shell"]);
      for (const name of workspacePackageNames) {
        if (presentNames.has(name)) shellLockTargetNames.add(name);
      }
      const nextShellLockSource = updateCargoLockWorkspaceVersions(
        shellLockSource,
        shellLockTargetNames,
        releaseVersion,
      );
      if (nextShellLockSource !== shellLockSource) {
        await writeFile(shellLockPath, nextShellLockSource, "utf8");
      }
    }
  } catch (error) {
    await Promise.all([
      writeFile(packagePath, packageSource, "utf8"),
      writeFile(lockPath, lockSource, "utf8"),
      writeFile(cargoManifestPath, cargoManifestSource, "utf8"),
      writeFile(cargoLockPath, cargoLockSource, "utf8"),
      ...(hasDesktopShell
        ? [
            writeFile(shellCargoPath, shellCargoSource, "utf8"),
            writeFile(shellLockPath, shellLockSource, "utf8"),
            writeFile(shellTauriConfPath, shellTauriConfSource, "utf8"),
          ]
        : []),
    ]);
    throw new Error(
      `failed to synchronize Cargo.lock: ${error instanceof Error ? error.message : error}`,
      { cause: error },
    );
  }

  const nextCargoLockSource = await readFile(cargoLockPath, "utf8");
  const nextShellLockSource = hasDesktopShell ? await readFile(shellLockPath, "utf8") : null;
  const changedFiles = [
    ...(nextPackageSource !== packageSource ? ["package.json"] : []),
    ...(nextLockSource !== lockSource ? ["package-lock.json"] : []),
    ...(nextCargoManifestSource !== cargoManifestSource ? ["Cargo.toml"] : []),
    ...(nextCargoLockSource !== cargoLockSource ? ["Cargo.lock"] : []),
    ...(hasDesktopShell && nextShellCargoSource !== shellCargoSource
      ? [DESKTOP_SHELL_CARGO_TOML]
      : []),
    ...(hasDesktopShell && nextShellLockSource !== shellLockSource
      ? [DESKTOP_SHELL_CARGO_LOCK]
      : []),
    ...(hasDesktopShell && nextShellTauriConfSource !== shellTauriConfSource
      ? [DESKTOP_SHELL_TAURI_CONF]
      : []),
  ];

  return { changedFiles, tag: `v${releaseVersion}`, version: releaseVersion };
}

export async function runReleasePrepareCli(arguments_) {
  const parsed = parseReleasePrepareArguments(arguments_);
  if (parsed.help) {
    console.log("usage: npm run release:prepare -- <semver>");
    return;
  }
  const prepared = await prepareReleaseVersion({ version: parsed.version });
  console.log(`version=${prepared.version}`);
  console.log(`tag=${prepared.tag}`);
  console.log(
    `updated=${prepared.changedFiles.length > 0 ? prepared.changedFiles.join(",") : "none"}`,
  );
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  runReleasePrepareCli(process.argv.slice(2)).catch((error) => {
    console.error(`codexhost release prepare: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
