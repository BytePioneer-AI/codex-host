import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
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
import { requireSemanticVersion, SEMVER_PATTERN } from "./status.js";

const STAGING_SCHEMA_VERSION = 1;
const STAGING_LOCK_FILE = "staging-v1.lock";
const STAGING_LOCK_TTL_SECONDS = 30 * 60;
const STAGING_LOCK_WRITE_GRACE_MS = 5_000;
const STAGED_DIRECTORY_NAME = "staged";
const STAGED_METADATA_FILE = "staged-v1.json";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const NPM_CACHE_FILE_PATTERN =
  /^content-v2\/(?:sha512|sha256|sha1)\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]+$/u;
const RELEASE_TARGETS = new Set<ReleaseTarget>([
  "macos-arm64",
  "macos-x64",
  "windows-x64",
  "windows-arm64",
  "linux-x64",
  "linux-arm64",
]);
// Windows antivirus/indexer scans can hold newly downloaded files for ~1.5s.
const WINDOWS_RENAME_RETRY_DELAYS_MS = [20, 50, 100, 200, 350, 500, 800] as const;

export interface StagedUpdateRecord {
  schemaVersion: 1;
  version: string;
  distribution: "npm" | "installer";
  target: ReleaseTarget;
  stagedAt: number;
  npmConfigSha256?: string;
  npmCacheFiles?: string[];
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
  npmConfigSha256?: string;
  npmCacheDirectory?: string;
  resolveCacheFiles?: (target: NpmReleaseTarget) => Promise<string[]>;
  prefetchNpm?: (
    target: NpmReleaseTarget,
    onProgress?: (progress: NpmDownloadProgress) => void | Promise<void>,
  ) => Promise<void>;
  onProgress?: (progress: NpmDownloadProgress) => void | Promise<void>;
  now?: () => number;
}

export interface VerifyStagedNpmOptions {
  version: string;
  target?: ReleaseTarget;
  npmConfigSha256?: string;
  npmCacheDirectory?: string;
}

export interface CleanupStagedUpdatesOptions {
  currentVersion?: string;
  keepVersion?: string;
  now?: () => number;
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

export function normalizePathForContainment(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    let stripped = filePath;
    if (/^\\\\\?\\UNC\\/iu.test(stripped)) {
      stripped = `\\\\${stripped.slice(8)}`;
    } else if (stripped.startsWith("\\\\?\\")) {
      stripped = stripped.slice(4);
    }
    return path.win32.normalize(stripped).toLowerCase();
  }
  return path.posix.normalize(filePath);
}

export function isPathInsideRoot(
  rootPath: string,
  candidatePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalizedRoot = normalizePathForContainment(rootPath, platform);
  const normalizedCandidate = normalizePathForContainment(candidatePath, platform);
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const relative = pathImpl.relative(normalizedRoot, normalizedCandidate);
  return relative.length > 0 && !relative.startsWith("..") && !pathImpl.isAbsolute(relative);
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

async function recoverStagingLock(
  stateDirectory: string,
  now: () => number = Date.now,
): Promise<void> {
  const lockPath = stagingLockPath(stateDirectory);
  let metadata;
  try {
    metadata = await lstat(lockPath);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) return;
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    const code = systemErrorCode(error);
    if (code === "ENOENT" || code === "EACCES" || code === "EBUSY" || code === "EPERM") return;
    throw error;
  }
  const nowMs = now();
  const nowSeconds = Math.floor(nowMs / 1000);
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ownerPid = parsed.ownerPid;
    const startedAt = parsed.startedAt;
    const pidAlive = typeof ownerPid === "number" && processIsAlive(ownerPid);
    const expired =
      typeof startedAt !== "number" ||
      !Number.isSafeInteger(startedAt) ||
      startedAt < 0 ||
      nowSeconds - startedAt >= STAGING_LOCK_TTL_SECONDS;
    if (!pidAlive || expired) {
      await rm(lockPath, { force: true });
    }
  } catch {
    // A freshly created fallback lock file may briefly be empty before its payload is flushed.
    if (nowMs - metadata.mtimeMs < STAGING_LOCK_WRITE_GRACE_MS) return;
    await rm(lockPath, { force: true });
  }
}

async function acquireStagingLock(
  stateDirectory: string,
  now: () => number,
): Promise<{ release(): Promise<void> } | null> {
  const root = requireAbsoluteDirectory(stateDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await recoverStagingLock(root, now);
  const lockPath = stagingLockPath(root);
  const token = randomUUID();
  const payload = `${JSON.stringify({
    ownerPid: process.pid,
    startedAt: Math.floor(now() / 1000),
    token,
  })}\n`;
  const temporaryLockPath = path.join(root, `.staging-v1-${token}.tmp`);

  try {
    const handle = await open(temporaryLockPath, "wx", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryLockPath, lockPath);
    } catch (error) {
      const code = systemErrorCode(error);
      if (code === "EEXIST") return null;
      if (code === "EXDEV" || code === "ENOTSUP" || code === "ENOSYS") {
        let fallbackHandle: FileHandle;
        try {
          fallbackHandle = await open(lockPath, "wx", 0o600);
        } catch (fallbackError) {
          if (systemErrorCode(fallbackError) === "EEXIST") return null;
          throw fallbackError;
        }
        try {
          await fallbackHandle.writeFile(payload, "utf8");
          await fallbackHandle.sync();
        } catch (writeError) {
          await fallbackHandle.close().catch(() => undefined);
          await rm(lockPath, { force: true }).catch(() => undefined);
          throw writeError;
        }
        await fallbackHandle.close();
      } else {
        throw error;
      }
    }
  } finally {
    await rm(temporaryLockPath, { force: true });
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        const current = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
        if (current.token !== token) return;
      } catch {
        // Never remove the lock file unless ownership is positively verified.
        return;
      }
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
    "npmConfigSha256",
    "npmCacheFiles",
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
    if (
      record.npmConfigSha256 !== undefined &&
      (typeof record.npmConfigSha256 !== "string" || !SHA256_PATTERN.test(record.npmConfigSha256))
    ) {
      throw new Error("staged npm metadata has an invalid npmConfigSha256");
    }
    let npmCacheFiles: string[] | undefined;
    if (record.npmCacheFiles !== undefined) {
      if (
        !Array.isArray(record.npmCacheFiles) ||
        record.npmCacheFiles.length > 8 ||
        record.npmCacheFiles.some(
          (entry) => typeof entry !== "string" || !NPM_CACHE_FILE_PATTERN.test(entry),
        )
      ) {
        throw new Error("staged npm metadata has invalid npmCacheFiles");
      }
      npmCacheFiles = record.npmCacheFiles as string[];
    }
    return {
      schemaVersion: 1,
      version,
      distribution: "npm",
      target: record.target as ReleaseTarget,
      stagedAt: record.stagedAt,
      ...(record.npmConfigSha256 !== undefined ? { npmConfigSha256: record.npmConfigSha256 } : {}),
      ...(npmCacheFiles !== undefined ? { npmCacheFiles } : {}),
    };
  }
  if (record.npmConfigSha256 !== undefined || record.npmCacheFiles !== undefined) {
    throw new Error("staged installer metadata must not include npm staging fields");
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
  if (staged.sha256 !== expectedSource.sha256) return null;
  if (expectedSource.size !== undefined && staged.size !== expectedSource.size) return null;
  const stagedRoot = stagedDirectoryPath(stateDirectory);
  try {
    // Reject direct symlinks and parent symlink/junction escapes outside stagedRoot.
    const entryMeta = await lstat(staged.artifactPath);
    if (!entryMeta.isFile() || entryMeta.isSymbolicLink()) return null;
    const [realStagedRoot, realArtifactPath] = await Promise.all([
      realpath(stagedRoot),
      realpath(staged.artifactPath),
    ]);
    if (!isPathInsideRoot(realStagedRoot, realArtifactPath)) return null;
    const size = await verifyArtifactFile(expectedSource, realArtifactPath);
    if (staged.size !== undefined && size !== staged.size) return null;
    return { artifactPath: realArtifactPath, size };
  } catch {
    return null;
  }
}

export async function cleanupStagedUpdates(
  stateDirectory: string,
  options: CleanupStagedUpdatesOptions = {},
): Promise<void> {
  const root = requireAbsoluteDirectory(stateDirectory);
  const now = options.now ?? Date.now;
  await recoverStagingLock(root, now);
  const stagedRoot = stagedDirectoryPath(root);
  try {
    await lstat(stagedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const lock = await acquireStagingLock(root, now);
  if (!lock) return;
  try {
    if (options.currentVersion !== undefined) {
      const currentVersion = requireSemanticVersion(options.currentVersion);
      const staged = await readStagedUpdate(root);
      if (staged) {
        if (compareSemanticVersions(currentVersion, staged.version) >= 0) {
          await rm(stagedRoot, { recursive: true, force: true });
        }
        return;
      }
      let entries;
      try {
        entries = await readdir(stagedRoot, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith("update-")) {
          continue;
        }
        const candidateVersion = entry.name.slice("update-".length);
        if (!SEMVER_PATTERN.test(candidateVersion)) continue;
        if (compareSemanticVersions(currentVersion, candidateVersion) >= 0) {
          await rm(path.join(stagedRoot, entry.name), { recursive: true, force: true });
        }
      }
      const remaining = await readdir(stagedRoot).catch(() => null);
      if (remaining !== null && remaining.length === 0) {
        await rmdir(stagedRoot).catch(() => undefined);
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
    await rmdir(versionDirectory).catch(() => undefined);
    await rmdir(stagedDirectoryPath(root)).catch(() => undefined);
    throw error;
  } finally {
    await lock.release();
  }
}

async function nonEmptyDirectory(directoryPath: string): Promise<boolean> {
  try {
    const entries = await readdir(directoryPath);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function verifyNpmCacheContentFiles(
  cacacheRoot: string,
  relativeFiles: readonly string[],
): Promise<boolean> {
  let realCacacheRoot: string;
  try {
    realCacacheRoot = await realpath(cacacheRoot);
  } catch {
    return false;
  }
  for (const relativeFile of relativeFiles) {
    if (!NPM_CACHE_FILE_PATTERN.test(relativeFile)) return false;
    const candidate = path.join(realCacacheRoot, ...relativeFile.split("/"));
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) return false;
      const realCandidate = await realpath(candidate);
      if (!isPathInsideRoot(realCacacheRoot, realCandidate)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export async function verifyStagedNpm(
  staged: StagedUpdateRecord,
  options: VerifyStagedNpmOptions,
): Promise<boolean> {
  if (staged.distribution !== "npm") return false;
  if (staged.version !== options.version) return false;
  if (options.target && staged.target !== options.target) return false;
  if (options.npmConfigSha256 && staged.npmConfigSha256 !== options.npmConfigSha256) return false;
  if (options.npmCacheDirectory) {
    const cacacheRoot = path.join(options.npmCacheDirectory, "_cacache");
    const [hasIndex, hasContent] = await Promise.all([
      nonEmptyDirectory(path.join(cacacheRoot, "index-v5")),
      nonEmptyDirectory(path.join(cacacheRoot, "content-v2")),
    ]);
    if (!hasIndex || !hasContent) return false;
    if (staged.npmCacheFiles && staged.npmCacheFiles.length > 0) {
      if (!(await verifyNpmCacheContentFiles(cacacheRoot, staged.npmCacheFiles))) return false;
    }
  }
  return true;
}

export async function stageNpm(options: StageNpmOptions): Promise<StagedUpdateRecord> {
  const root = requireAbsoluteDirectory(options.stateDirectory);
  const version = requireSemanticVersion(options.version);
  if (options.npmConfigSha256 !== undefined && !SHA256_PATTERN.test(options.npmConfigSha256)) {
    throw new Error("npmConfigSha256 must be lowercase hexadecimal");
  }
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
      (await verifyStagedNpm(existing, {
        version,
        target: options.target,
        ...(options.npmConfigSha256 ? { npmConfigSha256: options.npmConfigSha256 } : {}),
        ...(options.npmCacheDirectory ? { npmCacheDirectory: options.npmCacheDirectory } : {}),
      }))
    ) {
      return existing;
    }

    await removeOtherStagedVersionDirectories(root);
    await prefetch(options.npmTarget, options.onProgress);
    let verifiedCacheFiles: string[] | undefined;
    if (options.npmCacheDirectory && options.resolveCacheFiles) {
      const candidateFiles = await options.resolveCacheFiles(options.npmTarget).catch(() => []);
      if (
        candidateFiles.length > 0 &&
        (await verifyNpmCacheContentFiles(
          path.join(options.npmCacheDirectory, "_cacache"),
          candidateFiles,
        ))
      ) {
        verifiedCacheFiles = candidateFiles;
      }
    }
    const record: StagedUpdateRecord = {
      schemaVersion: 1,
      version,
      distribution: "npm",
      target: options.target,
      stagedAt: Math.floor(now() / 1000),
      ...(options.npmConfigSha256 ? { npmConfigSha256: options.npmConfigSha256 } : {}),
      ...(verifiedCacheFiles ? { npmCacheFiles: verifiedCacheFiles } : {}),
    };
    await writeStagedMetadata(root, record);
    return record;
  } finally {
    await lock.release();
  }
}
