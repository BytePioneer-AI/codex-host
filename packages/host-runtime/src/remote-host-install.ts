import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const MANIFEST_FORMAT = 1;
// Kept only so status/install can identify and migrate preview installs.
const WRAPPER_MARKER = "# codexhost remote SSH wrapper v1";
const PROFILE_START = "# >>> codexhost remote SSH >>>";
const PROFILE_END = "# <<< codexhost remote SSH <<<";

interface RemoteHostManifestV1 {
  format: 1;
  wrapperPath: string;
  profilePath: string;
  stockCodexPath: string;
  nodePath: string;
  shimPath: string;
  hostRuntimePath: string;
  dataDirectory: string;
  entrypointSha256?: string;
  claudeCommand?: string;
  profileBackupPath?: string;
}

export interface RemoteHostInstallOptions {
  home?: string;
  installRoot?: string;
  profilePath?: string;
  stockCodexPath?: string;
  nodePath?: string;
  shimPath?: string;
  hostRuntimePath?: string;
  claudeCommand?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
}

export type RemoteHostInstallationStatus =
  | { state: "not-installed"; wrapperPath: string; profilePath: string }
  | ({ state: "ready" | "degraded"; issues: string[] } & RemoteHostManifestV1);

interface ResolvedRemoteHostPaths {
  home: string;
  installRoot: string;
  binDirectory: string;
  wrapperPath: string;
  manifestPath: string;
  dataDirectory: string;
  profilePath: string;
}

function resolvePaths(options: RemoteHostInstallOptions): ResolvedRemoteHostPaths {
  const environment = options.environment ?? process.env;
  const configuredHome = options.home ?? environment.HOME;
  if (!configuredHome) {
    throw new Error("A non-root HOME is required for remote Host installation");
  }
  const home = path.resolve(configuredHome);
  if (!home || home === path.parse(home).root) {
    throw new Error("A non-root HOME is required for remote Host installation");
  }
  const installRoot = path.resolve(options.installRoot ?? path.join(home, ".codexhost", "remote"));
  const profilePath = path.resolve(
    options.profilePath ??
      path.join(
        home,
        path.basename(environment.SHELL ?? "") === "zsh"
          ? ".zshenv"
          : path.basename(environment.SHELL ?? "") === "bash"
            ? ".bashrc"
            : ".profile",
      ),
  );
  const binDirectory = path.join(installRoot, "bin");
  return {
    home,
    installRoot,
    binDirectory,
    wrapperPath: path.join(binDirectory, "codex"),
    manifestPath: path.join(installRoot, "manifest.json"),
    dataDirectory: path.join(installRoot, "data"),
    profilePath,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function existingText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function fileSha256(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function executable(filePath: string, label: string): Promise<string> {
  const absolute = path.resolve(filePath);
  try {
    if (!(await stat(absolute)).isFile()) throw new Error("not a regular file");
    await access(absolute, fsConstants.X_OK);
  } catch {
    throw new Error(`${label} is not an executable file: ${absolute}`);
  }
  return absolute;
}

async function existingFile(filePath: string, label: string): Promise<string> {
  const absolute = path.resolve(filePath);
  try {
    const metadata = await stat(absolute);
    if (!metadata.isFile()) throw new Error("not a regular file");
  } catch {
    throw new Error(`${label} is not a regular file: ${absolute}`);
  }
  return absolute;
}

async function discoverExecutable(
  name: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | null> {
  for (const directory of (environment.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.resolve(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

async function writeAtomic(filePath: string, contents: string, mode: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode });
    await chmod(temporary, mode);
    try {
      await rename(temporary, filePath);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      await rm(filePath, { force: true });
      await rename(temporary, filePath);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeAtomicExecutable(filePath: string, sourcePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await copyFile(sourcePath, temporary);
    await chmod(temporary, 0o700);
    try {
      await rename(temporary, filePath);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      await rm(filePath, { force: true });
      await rename(temporary, filePath);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function managedBlockRange(contents: string): { start: number; end: number } | null {
  const start = contents.indexOf(PROFILE_START);
  const endMarker = contents.indexOf(PROFILE_END);
  if (start < 0 && endMarker < 0) return null;
  if (
    start < 0 ||
    endMarker < start ||
    contents.indexOf(PROFILE_START, start + PROFILE_START.length) >= 0 ||
    contents.indexOf(PROFILE_END, endMarker + PROFILE_END.length) >= 0
  ) {
    throw new Error("Shell profile contains a malformed codexhost remote SSH block");
  }
  let end = endMarker + PROFILE_END.length;
  if (contents.slice(end, end + 2) === "\r\n") end += 2;
  else if (contents[end] === "\n") end += 1;
  return { start, end };
}

function removeManagedProfileBlock(contents: string): string {
  const range = managedBlockRange(contents);
  return range ? `${contents.slice(0, range.start)}${contents.slice(range.end)}` : contents;
}

function installManagedProfileBlock(contents: string, manifest: RemoteHostManifestV1): string {
  const base = removeManagedProfileBlock(contents);
  const separator = base.length > 0 && !base.endsWith("\n") ? "\n" : "";
  const environment = [
    `export CODEX_INSTALL_DIR=${shellQuote(path.dirname(manifest.wrapperPath))}`,
    `export CODEXHOST_STOCK_CODEX_PATH=${shellQuote(manifest.stockCodexPath)}`,
    `export CODEXHOST_HOST_NODE_PATH=${shellQuote(manifest.nodePath)}`,
    `export CODEXHOST_HOST_RUNTIME_PATH=${shellQuote(manifest.hostRuntimePath)}`,
    `export CODEXHOST_DATA_DIR=${shellQuote(manifest.dataDirectory)}`,
    "export CODEXHOST_DEFAULT_AGENT='codex'",
    "export CODEXHOST_REMOTE_SSH_MANAGED='1'",
    ...(manifest.claudeCommand
      ? [`export CODEXHOST_CLAUDE_COMMAND=${shellQuote(manifest.claudeCommand)}`]
      : []),
  ];
  return `${base}${separator}${PROFILE_START}\n${environment.join("\n")}\n${PROFILE_END}\n`;
}

type ManagedEntrypointState =
  "missing" | "native" | "legacy-wrapper" | "source-missing" | "modified";

async function managedEntrypointState(
  manifest: RemoteHostManifestV1,
): Promise<ManagedEntrypointState> {
  const metadata = await lstat(manifest.wrapperPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (metadata === null) return "missing";
  if (!metadata.isFile()) return "modified";
  const entrypoint = await readFile(manifest.wrapperPath);
  if (
    entrypoint
      .subarray(0, 256)
      .toString("utf8")
      .startsWith(`#!/usr/bin/env sh\n${WRAPPER_MARKER}\n`)
  ) {
    return "legacy-wrapper";
  }
  if (manifest.entrypointSha256 !== undefined) {
    return createHash("sha256").update(entrypoint).digest("hex") === manifest.entrypointSha256
      ? "native"
      : "modified";
  }
  const shim = await readFile(manifest.shimPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (shim === null) return "source-missing";
  return entrypoint.equals(shim) ? "native" : "modified";
}

async function readManifest(filePath: string): Promise<RemoteHostManifestV1 | null> {
  const source = await existingText(filePath);
  if (source === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Remote Host manifest is malformed");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Remote Host manifest has an unsupported format");
  }
  const manifest = value as Record<string, unknown>;
  const allowed = new Set([
    "format",
    "wrapperPath",
    "profilePath",
    "stockCodexPath",
    "nodePath",
    "shimPath",
    "hostRuntimePath",
    "dataDirectory",
    "entrypointSha256",
    "claudeCommand",
    "profileBackupPath",
  ]);
  const requiredPaths = [
    "wrapperPath",
    "profilePath",
    "stockCodexPath",
    "nodePath",
    "shimPath",
    "hostRuntimePath",
    "dataDirectory",
  ] as const;
  const optionalPaths = ["claudeCommand", "profileBackupPath"] as const;
  if (
    manifest.format !== MANIFEST_FORMAT ||
    Object.keys(manifest).some((key) => !allowed.has(key)) ||
    requiredPaths.some(
      (key) => typeof manifest[key] !== "string" || !path.isAbsolute(manifest[key]),
    ) ||
    optionalPaths.some(
      (key) =>
        manifest[key] !== undefined &&
        (typeof manifest[key] !== "string" || !path.isAbsolute(manifest[key])),
    ) ||
    (manifest.entrypointSha256 !== undefined &&
      (typeof manifest.entrypointSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(manifest.entrypointSha256)))
  ) {
    throw new Error("Remote Host manifest has an unsupported format");
  }
  return manifest as unknown as RemoteHostManifestV1;
}

async function backupProfile(
  profilePath: string,
  contents: string,
  action: string,
): Promise<string> {
  const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/gu, "");
  const backupPath = `${profilePath}.codexhost-${action}-${timestamp}.bak`;
  const metadata = await stat(profilePath).catch(() => null);
  await writeAtomic(backupPath, contents, metadata?.mode ?? 0o600);
  return backupPath;
}

export async function installRemoteHost(
  options: RemoteHostInstallOptions,
): Promise<RemoteHostManifestV1> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    throw new Error("Remote Host installation must run on the macOS or Linux SSH host");
  }
  const environment = options.environment ?? process.env;
  const paths = resolvePaths(options);
  const previousManifest = await readManifest(paths.manifestPath);
  const existingEntrypoint = await lstat(paths.wrapperPath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (existingEntrypoint !== null && previousManifest === null) {
    throw new Error(`Refusing to overwrite unmanaged Codex entrypoint: ${paths.wrapperPath}`);
  }
  if (previousManifest && previousManifest.wrapperPath !== paths.wrapperPath) {
    throw new Error("Remote Host manifest points at a different Codex entrypoint");
  }
  if (
    previousManifest &&
    options.profilePath !== undefined &&
    previousManifest.profilePath !== paths.profilePath
  ) {
    throw new Error(
      "Remote Host is already installed with a different shell profile; uninstall it first",
    );
  }
  const profilePath = previousManifest?.profilePath ?? paths.profilePath;

  const discoveredStock =
    options.stockCodexPath ??
    previousManifest?.stockCodexPath ??
    (await discoverExecutable("codex", environment));
  if (!discoveredStock) throw new Error("Could not locate the existing Codex entrypoint");
  const stockCodexPath = await executable(discoveredStock, "Existing Codex entrypoint");
  if (stockCodexPath === paths.wrapperPath) {
    throw new Error("Existing Codex entrypoint resolves to the managed remote entrypoint");
  }
  if (!options.nodePath || !options.shimPath || !options.hostRuntimePath) {
    throw new Error(
      "Remote Host installation requires packaged Node, Shim, and Host Runtime paths",
    );
  }
  const nodePath = await executable(options.nodePath, "Node runtime");
  const shimPath = await executable(options.shimPath, "codexhost Shim");
  const hostRuntimePath = await existingFile(options.hostRuntimePath, "codexhost Host Runtime");
  const discoveredClaude =
    options.claudeCommand ??
    previousManifest?.claudeCommand ??
    (await discoverExecutable("claude", environment));
  const claudeCommand = discoveredClaude
    ? await executable(discoveredClaude, "Claude Code command")
    : undefined;

  let manifest: RemoteHostManifestV1 = {
    format: MANIFEST_FORMAT,
    wrapperPath: paths.wrapperPath,
    profilePath,
    stockCodexPath,
    nodePath,
    shimPath,
    hostRuntimePath,
    dataDirectory: paths.dataDirectory,
    ...(claudeCommand ? { claudeCommand } : {}),
    ...(previousManifest?.profileBackupPath
      ? { profileBackupPath: previousManifest.profileBackupPath }
      : {}),
  };
  const existingProfile = (await existingText(profilePath)) ?? "";
  const nextProfile = installManagedProfileBlock(existingProfile, manifest);
  if (nextProfile !== existingProfile) {
    const profileBackupPath = await backupProfile(profilePath, existingProfile, "install");
    manifest = { ...manifest, profileBackupPath };
    const metadata = await stat(profilePath).catch(() => null);
    await writeAtomic(profilePath, nextProfile, metadata?.mode ?? 0o600);
  }
  await mkdir(paths.dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(paths.dataDirectory, 0o700);
  await writeAtomicExecutable(paths.wrapperPath, manifest.shimPath);
  manifest = { ...manifest, entrypointSha256: await fileSha256(paths.wrapperPath) };
  await writeAtomic(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  return manifest;
}

export async function inspectRemoteHostInstallation(
  options: RemoteHostInstallOptions,
): Promise<RemoteHostInstallationStatus> {
  const paths = resolvePaths(options);
  const manifest = await readManifest(paths.manifestPath);
  if (!manifest) {
    return {
      state: "not-installed",
      wrapperPath: paths.wrapperPath,
      profilePath: paths.profilePath,
    };
  }
  const issues: string[] = [];
  const entrypointState = await managedEntrypointState(manifest);
  if (entrypointState === "legacy-wrapper") {
    issues.push("managed entrypoint uses the legacy blocking shell wrapper; reinstall to migrate");
  } else if (entrypointState === "source-missing") {
    issues.push(
      "managed native entrypoint cannot be verified because the source Shim is unavailable",
    );
  } else if (entrypointState !== "native") {
    issues.push("managed native entrypoint is missing or modified");
  }
  const profile = (await existingText(manifest.profilePath)) ?? "";
  const expectedProfile = installManagedProfileBlock(removeManagedProfileBlock(profile), manifest);
  if (profile !== expectedProfile) {
    issues.push("shell profile does not configure the managed native entrypoint");
  }
  const dataDirectory = await stat(manifest.dataDirectory).catch(() => null);
  if (!dataDirectory?.isDirectory()) issues.push("remote Host data directory is unavailable");
  for (const [label, filePath, requiresExecutable] of [
    ["stock Codex", manifest.stockCodexPath, true],
    ["Node runtime", manifest.nodePath, true],
    ["Shim", manifest.shimPath, true],
    ["Host Runtime", manifest.hostRuntimePath, false],
  ] as const) {
    try {
      if (requiresExecutable) await executable(filePath, label);
      else if (!(await stat(filePath)).isFile()) throw new Error("not a regular file");
    } catch {
      issues.push(`${label} is unavailable`);
    }
  }
  return { state: issues.length === 0 ? "ready" : "degraded", issues, ...manifest };
}

export async function uninstallRemoteHost(options: RemoteHostInstallOptions): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    throw new Error("Remote Host uninstallation must run on the macOS or Linux SSH host");
  }
  const paths = resolvePaths(options);
  const manifest = await readManifest(paths.manifestPath);
  if (!manifest) return;
  if (
    manifest.wrapperPath !== paths.wrapperPath ||
    (options.profilePath !== undefined && manifest.profilePath !== paths.profilePath)
  ) {
    throw new Error("Remote Host manifest does not match the requested installation");
  }
  const entrypointState = await managedEntrypointState(manifest);
  if (entrypointState === "source-missing") {
    throw new Error("Refusing to remove an unverifiable remote Codex entrypoint");
  }
  if (entrypointState === "modified") {
    throw new Error("Refusing to remove a modified remote Codex entrypoint");
  }
  const profile = (await existingText(manifest.profilePath)) ?? "";
  const nextProfile = removeManagedProfileBlock(profile);
  if (nextProfile !== profile) {
    await backupProfile(manifest.profilePath, profile, "uninstall");
    const metadata = await stat(manifest.profilePath).catch(() => null);
    await writeAtomic(manifest.profilePath, nextProfile, metadata?.mode ?? 0o600);
  }
  await rm(manifest.wrapperPath, { force: true });
  await rm(paths.manifestPath, { force: true });
  await rmdir(paths.binDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
  });
  await rmdir(paths.installRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
  });
}
