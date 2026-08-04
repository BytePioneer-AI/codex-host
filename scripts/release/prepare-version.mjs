import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);
const semverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function validateReleaseVersion(version) {
  if (!semverPattern.test(version)) {
    throw new Error(`release version '${version}' must be valid semver`);
  }
  if (version === "0.0.0") {
    throw new Error("release version must not be 0.0.0");
  }
  return version;
}

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

export function updateCargoWorkspaceVersion(source, version) {
  const header = /^\[workspace\.package\][ \t]*\r?$/mu.exec(source);
  if (!header) throw new Error("Cargo.toml must define [workspace.package]");

  const bodyStart = header.index + header[0].length;
  const sectionPattern = /^\[[^\r\n]+\][ \t]*\r?$/gmu;
  sectionPattern.lastIndex = bodyStart;
  const nextSection = sectionPattern.exec(source);
  const bodyEnd = nextSection?.index ?? source.length;
  const body = source.slice(bodyStart, bodyEnd);
  const versionPattern = /^([ \t]*version[ \t]*=[ \t]*)"[^"\r\n]*"([ \t]*(?:#.*)?)$/gmu;
  const matches = [...body.matchAll(versionPattern)];
  if (matches.length !== 1) {
    throw new Error("Cargo.toml [workspace.package] must define exactly one version");
  }

  const match = matches[0];
  const versionStart = bodyStart + match.index;
  const replacement = `${match[1]}"${version}"${match[2]}`;
  return source.slice(0, versionStart) + replacement + source.slice(versionStart + match[0].length);
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
}

export async function prepareReleaseVersion({ version, root = repositoryRoot }) {
  const releaseVersion = validateReleaseVersion(version);
  const packagePath = path.join(root, "package.json");
  const lockPath = path.join(root, "package-lock.json");
  const cargoManifestPath = path.join(root, "Cargo.toml");
  const cargoLockPath = path.join(root, "Cargo.lock");
  const [packageSource, lockSource, cargoManifestSource, cargoLockSource] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(lockPath, "utf8"),
    readFile(cargoManifestPath, "utf8"),
    readFile(cargoLockPath, "utf8"),
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

  try {
    await Promise.all([
      writeFile(packagePath, nextPackageSource, "utf8"),
      writeFile(lockPath, nextLockSource, "utf8"),
      writeFile(cargoManifestPath, nextCargoManifestSource, "utf8"),
    ]);
    await synchronizeCargoLock(root, releaseVersion);
  } catch (error) {
    await Promise.all([
      writeFile(packagePath, packageSource, "utf8"),
      writeFile(lockPath, lockSource, "utf8"),
      writeFile(cargoManifestPath, cargoManifestSource, "utf8"),
      writeFile(cargoLockPath, cargoLockSource, "utf8"),
    ]);
    throw new Error(
      `failed to synchronize Cargo.lock: ${error instanceof Error ? error.message : error}`,
      { cause: error },
    );
  }

  const nextCargoLockSource = await readFile(cargoLockPath, "utf8");
  const changedFiles = [
    ...(nextPackageSource !== packageSource ? ["package.json"] : []),
    ...(nextLockSource !== lockSource ? ["package-lock.json"] : []),
    ...(nextCargoManifestSource !== cargoManifestSource ? ["Cargo.toml"] : []),
    ...(nextCargoLockSource !== cargoLockSource ? ["Cargo.lock"] : []),
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
