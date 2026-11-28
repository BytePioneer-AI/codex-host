import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import {
  downloadArtifact,
  validateArtifact,
  verifyArtifactFile,
  verifyDownloadedArtifact,
  type ArtifactDownloader,
  type ArtifactDownloadProgress,
  type ArtifactSource,
} from "./artifact.js";
import { compareSemanticVersions, type ReleaseTarget } from "./github-release.js";
import {
  prefetchNpmRelease,
  type NpmDownloadProgress,
  type NpmReleaseTarget,
} from "./npm-registry.js";
import { requireSemanticVersion } from "./status.js";

const STAGING_SCHEMA_VERSION = 1;
const STAGING_LOCK_FILE = "staging-v1.lock";
const STAGED_DIRECTORY_NAME = "staged";
const STAGED_METADATA_FILE = "staged-v1.json";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RELEASE_TARGETS = new Set<ReleaseTarget>([
  "macos-arm64",
  "macos-x64",
  "windows-x64",
  "windows-arm64",
  "linux-x64",
  "linux-arm64",
]);
const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 30, 70, 150, 300] as const;

export interface StagedUpdateRecord {
  schemaVersion: 1;
  version: string;
  distribution: "npm" | "installer";
  target: ReleaseTarget;
  stagedAt: number;
  assetName?: string;
  artifactPath?: string;
  sha256?: string;
  size?: number;
}

export interface StageArtifactOptions {
  stateDirectory: string;
  version: string;
  target: ReleaseTarget;
  assetName: string;
  source: ArtifactSource;
  download?: ArtifactDownloader;
  onProgress?: (progress: ArtifactDownloadProgress) => void | Promise<void>;
  now?: () => number;
}

export interface StageNpmOptions {
  stateDirectory: string;
  version: string;
  target: ReleaseTarget;
  npmTarget: NpmReleaseTarget;
  prefetchNpm?: (
    target: NpmReleaseTarget,
    onProgress?: (progress: NpmDownloadProgress) => void | Promise<void>,
  ) => Promise<void>;
  onProgress?: (progress: NpmDownloadProgress) => void | Promise<void>;
  now?: () => number;
}

export interface CleanupStagedUpdatesOptions {
  currentVersion?: string;
  keepVersion?: string;
}

export interface VerifiedStagedArtifact {
  artifactPath: string;
  size: number;
}

function systemErrorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function replaceFile(temporaryPath: string, destinationPath: string): Promise<void> {
  let retryIndex = 0;
  for (;;) {
    try {
      await rename(temporaryPath, destinationPath);
      return;
    } catch (error) {
      const retryDelay = WINDOWS_RENAME_RETRY_DELAYS_MS[retryIndex];
      const code = systemErrorCode(error);
      if (
        process.platform !== "win32" ||
        retryDelay === undefined ||
        (code !== "EACCES" && code !== "EBUSY" && code !== "EPERM")
      ) {
        throw error;
      }
      retryIndex += 1;
      await delay(retryDelay);
    }
  }
}

function requireAbsoluteDirectory(value: string): string {
  if (!path.isAbsolute(value)) throw new Error("update state directory must be absolute");
  return path.normalize(value);
}

function requireSafeAssetName(value: string): string {
  if (
    value.length === 0 ||
    value.length > 160 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error("staged asset name is invalid");
  }
  return value;
}

function stagedDirectoryPath(stateDirectory: string): string {
  return path.join(requireAbsoluteDirectory(stateDirectory), STAGED_DIRECTORY_NAME);
}

function stagedMetadataPath(stateDirectory: string): string {
  return path.join(stagedDirectoryPath(stateDirectory), STAGED_METADATA_FILE);
}

function stagingLockPath(stateDirectory: string): string {
  return path.join(requireAbsoluteDirectory(stateDirectory), STAGING_LOCK_FILE);
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function processIsAlive(processId: number): boolean {
  if (!Number.isSafeInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function regularFile(filePath: string): Promise<boolean> {
  try {
    const metadata = await lstat(filePath);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function recoverStagingLock(stateDirectory: string): Promise<void> {
  const lockPath = stagingLockPath(stateDirectory);
  if (!(await regularFile(lockPath))) return;
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    const ownerPid = parsed.ownerPid;
    if (typeof ownerPid !== "number" || !processIsAlive(ownerPid)) {
      await rm(lockPath, { force: true });
    }
  } catch {
    // Remove malformed staging lock files so background staging can recover without affecting active updates.
    await rm(lockPath, { force: true });
  }
}

async function acquireStagingLock(
  stateDirectory: string,
  now: () => number,
): Promise<{ release(): Promise<void> } | null> {
  const root = requireAbsoluteDirectory(stateDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await recoverStagingLock(root);
  const lockPath = stagingLockPath(root);
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  await handle.writeFile(
    `${JSON.stringify({ ownerPid: process.pid, startedAt: Math.floor(now() / 1000) })}\n`,
    "utf8",
  );
  await handle.sync();
  await handle.close();
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await rm(lockPath, { force: true });
    },
  };
}

export function parseStagedUpdateRecord(value: unknown): StagedUpdateRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("staged update metadata must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "version",
    "distribution",
    "target",
    "stagedAt",
    "assetName",
    "artifactPath",
    "sha256",
    "size",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("staged update metadata contains unknown fields");
  }
  if (
    record.schemaVersion !== STAGING_SCHEMA_VERSION ||
    typeof record.version !== "string" ||
    (record.distribution !== "npm" && record.distribution !== "installer") ||
    typeof record.target !== "string" ||
    !RELEASE_TARGETS.has(record.target as ReleaseTarget) ||
    typeof record.stagedAt !== "number" ||
    !Number.isSafeInteger(record.stagedAt) ||
    record.stagedAt < 0
  ) {
    throw new Error("staged update metadata is invalid");
  }
  const version = requireSemanticVersion(record.version);
  if (record.distribution === "npm") {
    if (
      record.assetName !== undefined ||
      record.artifactPath !== undefined ||
      record.sha256 !== undefined ||
      record.size !== undefined
    ) {
      throw new Error("staged npm metadata must not include installer fields");
    }
    return {
      schemaVersion: 1,
      version,
      distribution: "npm",
      target: record.target as ReleaseTarget,
      stagedAt: record.stagedAt,
    };
  }
  if (
    typeof record.assetName !== "string" ||
    typeof record.artifactPath !== "string" ||
    !path.isAbsolute(record.artifactPath) ||
    typeof record.sha256 !== "string" ||
    !SHA256_PATTERN.test(record.sha256) ||
    typeof record.size !== "number" ||
    !Number.isSafeInteger(record.size) ||
    record.size <= 0
  ) {
    throw new Error("staged installer metadata is invalid");
  }
  return {
    schemaVersion: 1,
    version,
    distribution: "installer",
    target: record.target as ReleaseTarget,
    stagedAt: record.stagedAt,
    assetName: requireSafeAssetName(record.assetName),
    artifactPath: path.normalize(record.artifactPath),
    sha256: record.sha256,
    size: record.size,
  };
}

async function writeStagedMetadata(
  stateDirectory: string,
  record: StagedUpdateRecord,
): Promise<void> {
  const stagedRoot = stagedDirectoryPath(stateDirectory);
  await mkdir(stagedRoot, { recursive: true, mode: 0o700 });
  const destination = stagedMetadataPath(stateDirectory);
  const temporary = path.join(stagedRoot, `.staged-v1-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await replaceFile(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function removeOtherStagedVersionDirectories(
  stateDirectory: string,
  keepVersion?: string,
): Promise<void> {
  const stagedRoot = stagedDirectoryPath(stateDirectory);
  let entries;
  try {
    entries = await readdir(stagedRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const keepName = keepVersion ? `update-${keepVersion}` : null;
  for (const entry of entries) {
    if (!entry.name.startsWith("update-")) continue;
    if (keepName !== null && entry.name === keepName) continue;
    await rm(path.join(stagedRoot, entry.name), { recursive: true, force: true });
  }
}

export async function readStagedUpdate(stateDirectory: string): Promise<StagedUpdateRecord | null> {
  const metadataPath = stagedMetadataPath(stateDirectory);
  if (!(await regularFile(metadataPath))) return null;
  try {
    return parseStagedUpdateRecord(JSON.parse(await readFile(metadataPath, "utf8")));
  } catch {
    return null;
  }
}

export async function verifyStagedArtifact(
  stateDirectory: string,
  staged: StagedUpdateRecord,
  expectedSource: ArtifactSource,
): Promise<VerifiedStagedArtifact | null> {
  if (staged.distribution !== "installer" || !staged.artifactPath || !staged.sha256) {
    return null;
  }
  const stagedRoot = stagedDirectoryPath(stateDirectory);
  const normalizedArtifactPath = path.normalize(staged.artifactPath);
  if (!isPathInside(stagedRoot, normalizedArtifactPath)) return null;
  if (staged.sha256 !== expectedSource.sha256) return null;
  if (expectedSource.size !== undefined && staged.size !== expectedSource.size) return null;
  try {
    const size = await verifyArtifactFile(expectedSource, normalizedArtifactPath);
    if (staged.size !== undefined && size !== staged.size) return null;
    return { artifactPath: normalizedArtifactPath, size };
  } catch {
    return null;
  }
}

export async function cleanupStagedUpdates(
  stateDirectory: string,
  options: CleanupStagedUpdatesOptions = {},
): Promise<void> {
  const root = requireAbsoluteDirectory(stateDirectory);
  await recoverStagingLock(root);
  const stagedRoot = stagedDirectoryPath(root);
  try {
    await lstat(stagedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const lock = await acquireStagingLock(root, Date.now);
  if (!lock) return;
  try {
    if (options.currentVersion !== undefined) {
      const currentVersion = requireSemanticVersion(options.currentVersion);
      const staged = await readStagedUpdate(root);
      if (staged && compareSemanticVersions(currentVersion, staged.version) >= 0) {
        await rm(stagedRoot, { recursive: true, force: true });
      }
      return;
    }
    if (options.keepVersion !== undefined) {
      const keepVersion = requireSemanticVersion(options.keepVersion);
      await removeOtherStagedVersionDirectories(root, keepVersion);
      return;
    }
    await rm(stagedRoot, { recursive: true, force: true });
  } finally {
    await lock.release();
  }
}

export async function stageArtifact(options: StageArtifactOptions): Promise<StagedUpdateRecord> {
  const root = requireAbsoluteDirectory(options.stateDirectory);
  const version = requireSemanticVersion(options.version);
  const assetName = requireSafeAssetName(options.assetName);
  const source = validateArtifact(options.source);
  const now = options.now ?? Date.now;
  const download = options.download ?? downloadArtifact;

  const lock = await acquireStagingLock(root, now);
  if (!lock) {
    throw new Error("Another background update staging operation is already active");
  }
  const versionDirectory = path.join(stagedDirectoryPath(root), `update-${version}`);
  const artifactPath = path.join(versionDirectory, assetName);
  const temporaryPath = path.join(versionDirectory, `.${assetName}.${randomUUID()}.download`);
  try {
    const existing = await readStagedUpdate(root);
    if (
      existing &&
      existing.distribution === "installer" &&
      existing.version === version &&
      existing.target === options.target &&
      existing.assetName === assetName
    ) {
      const verified = await verifyStagedArtifact(root, existing, source);
      if (verified) {
        await removeOtherStagedVersionDirectories(root, version);
        return existing;
      }
    }

    await removeOtherStagedVersionDirectories(root, version);
    await mkdir(versionDirectory, { recursive: true, mode: 0o700 });
    const result = await download(source, temporaryPath, options.onProgress);
    const finalUrl = new URL(result.finalUrl);
    if (finalUrl.protocol !== "https:" || finalUrl.username || finalUrl.password) {
      throw new Error("update artifact downloader returned a non-HTTPS URL");
    }
    await verifyDownloadedArtifact(source, temporaryPath, result);
    await replaceFile(temporaryPath, artifactPath);

    const record: StagedUpdateRecord = {
      schemaVersion: 1,
      version,
      distribution: "installer",
      target: options.target,
      stagedAt: Math.floor(now() / 1000),
      assetName,
      artifactPath,
      sha256: source.sha256,
      size: result.bytes,
    };
    await writeStagedMetadata(root, record);
    await removeOtherStagedVersionDirectories(root, version);
    return record;
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  } finally {
    await lock.release();
  }
}

export async function stageNpm(options: StageNpmOptions): Promise<StagedUpdateRecord> {
  const root = requireAbsoluteDirectory(options.stateDirectory);
  const version = requireSemanticVersion(options.version);
  const now = options.now ?? Date.now;
  const prefetch =
    options.prefetchNpm ??
    ((
      target: NpmReleaseTarget,
      onProgress?: (progress: NpmDownloadProgress) => void | Promise<void>,
    ) => prefetchNpmRelease(target, undefined, onProgress));

  const lock = await acquireStagingLock(root, now);
  if (!lock) {
    throw new Error("Another background update staging operation is already active");
  }
  try {
    const existing = await readStagedUpdate(root);
    if (
      existing &&
      existing.distribution === "npm" &&
      existing.version === version &&
      existing.target === options.target
    ) {
      return existing;
    }

    await removeOtherStagedVersionDirectories(root);
    await prefetch(options.npmTarget, options.onProgress);
    const record: StagedUpdateRecord = {
      schemaVersion: 1,
      version,
      distribution: "npm",
      target: options.target,
      stagedAt: Math.floor(now() / 1000),
    };
    await writeStagedMetadata(root, record);
    return record;
  } finally {
    await lock.release();
  }
}
