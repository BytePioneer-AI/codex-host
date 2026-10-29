import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { parseDistributionMetadata } from "./distribution-metadata.js";

export function sameWindowsPath(left: string, right: string): boolean {
  const key = (value: string): string => {
    const normalized = path.normalize(value).replaceAll("/", "\\").toLowerCase();
    return normalized.startsWith("\\\\?\\") ? normalized.slice(4) : normalized;
  };
  return key(left) === key(right);
}

async function regularFile(file: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Not a regular installation file: ${file}`);
}

// Check every component below the owned root, not just the final file. Parent
// junctions and npm links must not redirect a replacement to another installation.
async function ownedPath(root: string, file: string): Promise<void> {
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Windows installation path escapes its root");
  }
  let current = root;
  for (const component of ["", ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, component);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Windows installation links are unsupported");
  }
  const resolvedRoot = await realpath(root);
  const resolved = await realpath(file);
  const expected = path.join(resolvedRoot, relative);
  if (!sameWindowsPath(resolved, expected))
    throw new Error("Windows installation path is redirected");
}

async function manifest(root: string): Promise<Record<string, unknown>> {
  const file = path.join(root, "package.json");
  await regularFile(file);
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid npm package manifest");
  return value as Record<string, unknown>;
}

export interface WindowsNpmPaths {
  installedVersion?: string;
  nodePath: string;
  npmCliPath: string;
  npmLauncherPath: string;
  packageRoot: string;
  launcherExecutable: string;
}

export async function validateWindowsNpmInstallation(
  options: WindowsNpmPaths,
  architecture: string,
): Promise<{ prefix: string; installedVersion: string }> {
  for (const value of [
    options.nodePath,
    options.npmCliPath,
    options.npmLauncherPath,
    options.packageRoot,
    options.launcherExecutable,
  ]) {
    if (!path.isAbsolute(value)) throw new Error("Windows npm paths must be absolute");
  }
  if (
    path.basename(options.npmLauncherPath).toLowerCase() !== "codexhost.js" ||
    path.basename(path.dirname(options.npmLauncherPath)).toLowerCase() !== "bin"
  ) {
    throw new Error("Windows npm CLI entry has an unsupported layout");
  }
  const cliRoot = path.dirname(path.dirname(options.npmLauncherPath));
  const prefix = path.resolve(cliRoot, "../../..");
  if (!sameWindowsPath(cliRoot, path.join(prefix, "node_modules", "@codexhost", "cli"))) {
    throw new Error("Windows npm CLI is not in a global prefix");
  }
  const cli = await manifest(cliRoot);
  const bin = cli.bin as Record<string, unknown> | undefined;
  if (cli.name !== "@codexhost/cli" || bin?.codexhost !== "bin/codexhost.js") {
    throw new Error("Windows npm CLI package identity is invalid");
  }
  const platformName = `@codexhost/cli-win32-${architecture}`;
  if (architecture !== "x64" && architecture !== "arm64")
    throw new Error("Unsupported Windows npm architecture");
  const nested = path.join(cliRoot, "node_modules", platformName);
  const hoisted = path.join(prefix, "node_modules", platformName);
  if (
    !sameWindowsPath(options.packageRoot, nested) &&
    !sameWindowsPath(options.packageRoot, hoisted)
  ) {
    throw new Error("Windows npm platform package is outside the CLI prefix");
  }
  const resolvedManifest = createRequire(options.npmLauncherPath).resolve(
    `${platformName}/package.json`,
  );
  if (!sameWindowsPath(path.dirname(resolvedManifest), await realpath(options.packageRoot))) {
    throw new Error("Windows npm platform package does not belong to this CLI entry");
  }
  for (const file of [
    options.npmLauncherPath,
    path.join(options.packageRoot, "package.json"),
    path.join(options.packageRoot, "app", "codexhost-distribution.json"),
    path.join(options.packageRoot, "bin", "codexhost.exe"),
    path.join(prefix, "codexhost.cmd"),
  ]) {
    await ownedPath(prefix, file);
    await regularFile(file);
  }
  const platform = await manifest(options.packageRoot);
  const metadata = parseDistributionMetadata(
    JSON.parse(
      await readFile(path.join(options.packageRoot, "app", "codexhost-distribution.json"), "utf8"),
    ),
  );
  const dependencies = cli.optionalDependencies as Record<string, unknown> | undefined;
  if (
    (options.installedVersion !== undefined && options.installedVersion !== metadata.version) ||
    platform.name !== platformName ||
    cli.version !== metadata.version ||
    platform.version !== metadata.version ||
    metadata.distribution !== "npm" ||
    metadata.target !== `windows-${architecture}` ||
    dependencies?.[platformName] !== metadata.version ||
    JSON.stringify(platform.os) !== '["win32"]' ||
    JSON.stringify(platform.cpu) !== JSON.stringify([architecture])
  ) {
    throw new Error("Windows npm package version, target or dependency identity does not match");
  }
  const shim = (await readFile(path.join(prefix, "codexhost.cmd"), "utf8"))
    .replaceAll("/", "\\")
    .toLowerCase();
  if (!shim.includes('"%dp0%\\node_modules\\@codexhost\\cli\\bin\\codexhost.js"')) {
    throw new Error("Windows npm global shim does not target the running CLI");
  }
  await regularFile(options.nodePath);
  await regularFile(options.npmCliPath);
  const npmRoot = path.dirname(path.dirname(options.npmCliPath));
  if (
    path.basename(options.npmCliPath).toLowerCase() !== "npm-cli.js" ||
    path.basename(path.dirname(options.npmCliPath)).toLowerCase() !== "bin" ||
    (await manifest(npmRoot)).name !== "npm"
  )
    throw new Error("Unverified npm CLI");
  const launcher = await realpath(options.launcherExecutable);
  if (
    !sameWindowsPath(launcher, await realpath(options.nodePath)) &&
    !sameWindowsPath(
      launcher,
      await realpath(path.join(options.packageRoot, "bin", "codexhost.exe")),
    )
  ) {
    throw new Error("Windows npm owner is not this installation's Launcher or Node");
  }
  return { prefix: await realpath(prefix), installedVersion: metadata.version };
}

export async function validateWindowsInstallerInstallation(
  installRoot: string,
  ownerExecutable: string,
  architecture: string,
  installedVersion?: string,
): Promise<string> {
  if (!path.isAbsolute(installRoot)) throw new Error("Windows install root must be absolute");
  const metadataPath = path.join(installRoot, "app", "codexhost-distribution.json");
  await ownedPath(installRoot, metadataPath);
  await regularFile(metadataPath);
  const metadata = parseDistributionMetadata(JSON.parse(await readFile(metadataPath, "utf8")));
  if (
    (installedVersion !== undefined && metadata.version !== installedVersion) ||
    metadata.distribution !== "installer" ||
    metadata.target !== `windows-${architecture}`
  ) {
    throw new Error("Windows installer target does not match this runtime");
  }
  const owner = await realpath(ownerExecutable);
  for (const relative of ["bin/codexhost.exe", "runtime/node.exe"]) {
    const candidate = path.join(installRoot, relative);
    await ownedPath(installRoot, candidate);
    await regularFile(candidate);
    if (sameWindowsPath(owner, await realpath(candidate))) return metadata.version;
  }
  throw new Error("Windows installer owner is outside the current installation");
}
