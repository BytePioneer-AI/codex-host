/** Confined workspace-scoped filesystem I/O for Peer preview, Office conversion, and downloads. */
import { constants, type BigIntStats, type Stats } from "node:fs";
import { lstat, open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { posix, win32 } from "node:path";

export type PeerWorkspacePathErrorCode =
  | "gateway/bad-request"
  | "gateway/cancelled"
  | "workspace-file/outside-workspace"
  | "workspace-file/not-found"
  | "workspace-file/not-regular-file"
  | "workspace-file/not-directory"
  | "workspace-file/not-text"
  | "workspace-file/too-large";

export interface PeerWorkspaceError {
  readonly ok: false;
  readonly code: PeerWorkspacePathErrorCode;
  readonly message: string;
  readonly details: Record<string, unknown>;
}

export type PeerWorkspacePathValidation =
  | {
      readonly ok: true;
      readonly realRoot: string;
      readonly pinnedRootStat: Stats | BigIntStats;
      readonly realPath: string;
    }
  | PeerWorkspaceError;

export interface PeerWorkspaceFsOps {
  readonly lstat: typeof lstat;
  readonly stat: typeof stat;
  readonly open: typeof open;
  readonly realpath: typeof realpath;
  readonly readdir?: typeof readdir;
  readonly platform: NodeJS.Platform;
  /** Optional hook invoked after path validation and right before opening/reading (used for TOCTOU tests). */
  readonly beforeOpen?: (realPath: string) => Promise<void> | void;
}

export interface ConfinedOpenFile {
  readonly handle: FileHandle;
  readonly realRoot: string;
  readonly realPath: string;
  readonly size: number;
  readonly version: string;
}

export interface ConfinedTextPage {
  readonly absolutePath: string;
  readonly version: string;
  readonly bytes: number;
  readonly offset: number;
  readonly text: string;
  readonly lines: number;
  readonly eof: boolean;
}

export interface ConfinedFileBytes {
  readonly absolutePath: string;
  readonly version: string;
  readonly bytes: number;
  readonly offset: number;
  readonly data: Buffer;
  readonly eof: boolean;
}

export interface ConfinedDirectoryEntry {
  readonly name: string;
  readonly type: "file" | "directory" | "other";
  readonly size?: number;
}

export interface ConfinedDirectoryListing {
  readonly path: string;
  readonly entries: readonly ConfinedDirectoryEntry[];
  readonly truncated: boolean;
}

export const PEER_FILE_LIMITS = {
  maxTextPageBytes: 2 * 1024 * 1024,
  maxByteRangeBytes: 2 * 1024 * 1024,
  maxFullFileBytes: 32 * 1024 * 1024,
  maxTextLines: 5_000,
  maxDirectoryEntries: 2_000,
  readChunkBytes: 64 * 1024,
} as const;

const DEFAULT_FS_OPS: PeerWorkspaceFsOps = {
  lstat,
  stat,
  open,
  realpath,
  readdir,
  platform: process.platform,
};

const MAX_PATH_LENGTH = 8192;
const OPEN_READONLY_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

type PathOps = typeof posix | typeof win32;

function isErrnoCode(error: unknown, ...codes: string[]): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && codes.includes(code);
}

function sameFileIdentity(
  left: Pick<Stats | BigIntStats, "dev" | "ino">,
  right: Pick<Stats | BigIntStats, "dev" | "ino">,
): boolean {
  return BigInt(left.dev) === BigInt(right.dev) && BigInt(left.ino) === BigInt(right.ino);
}

function versionOf(info: Stats | BigIntStats): string {
  if ("mtimeNs" in info && "ctimeNs" in info) {
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  }
  return `${info.dev}:${info.ino}:${info.size}:${Math.trunc(info.mtimeMs * 1_000_000)}:${Math.trunc(info.ctimeMs * 1_000_000)}`;
}

function pathOpsFor(platform: NodeJS.Platform): PathOps {
  return platform === "win32" ? win32 : posix;
}

function isPathWithinRoot(
  candidate: string,
  root: string,
  platform: NodeJS.Platform,
  pathOps: PathOps,
  allowEqual: boolean,
): boolean {
  const normCandidate = platform === "win32" ? candidate.toLowerCase() : candidate;
  const normRoot = platform === "win32" ? root.toLowerCase() : root;
  const rel = pathOps.relative(normRoot, normCandidate);
  if (rel === "") return allowEqual;
  return !rel.startsWith("..") && !pathOps.isAbsolute(rel);
}

function sanitizeInputPath(
  rawPath: unknown,
  platform: NodeJS.Platform,
): { readonly ok: true; readonly normalized: string } | PeerWorkspaceError {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.length > MAX_PATH_LENGTH) {
    return {
      ok: false,
      code: "gateway/bad-request",
      message: "path is required",
      details: {},
    };
  }
  if (/[\u0000-\u001f\u007f]/u.test(rawPath)) {
    return {
      ok: false,
      code: "gateway/bad-request",
      message: "path contains invalid control characters",
      details: {},
    };
  }
  const normalized = platform === "win32" ? rawPath.replace(/^\/(?=[A-Za-z]:[/\\])/u, "") : rawPath;
  if (normalized.startsWith("\\\\") || normalized.startsWith("//")) {
    return {
      ok: false,
      code: "workspace-file/outside-workspace",
      message: `"${rawPath}" is outside the workspace`,
      details: { path: rawPath },
    };
  }
  if (platform === "win32" && /^[A-Za-z]:(?![/\\])/u.test(normalized)) {
    return {
      ok: false,
      code: "gateway/bad-request",
      message: "drive-relative paths are not supported",
      details: {},
    };
  }
  return { ok: true, normalized };
}

async function hasNoSymlinkComponentsFromRoot(
  canonicalPath: string,
  pathOps: PathOps,
  fsOps: PeerWorkspaceFsOps,
): Promise<boolean> {
  const parsed = pathOps.parse(canonicalPath);
  if (!parsed.root) return false;
  const rel = pathOps.relative(parsed.root, canonicalPath);
  const segments = rel.split(/[\\/]/u).filter((segment) => segment.length > 0);
  let cursor = parsed.root;
  for (const segment of segments) {
    if (segment === "." || segment === "..") return false;
    cursor = pathOps.join(cursor, segment);
    const entryStat = await fsOps.lstat(cursor);
    if (entryStat.isSymbolicLink()) return false;
  }
  return true;
}

async function hasNoSymlinkComponentsUnderRoot(
  canonicalTarget: string,
  realRoot: string,
  pathOps: PathOps,
  fsOps: PeerWorkspaceFsOps,
  allowEqual: boolean,
): Promise<boolean> {
  if (!isPathWithinRoot(canonicalTarget, realRoot, fsOps.platform, pathOps, allowEqual)) {
    return false;
  }
  const rel = pathOps.relative(realRoot, canonicalTarget);
  if (rel === "") return allowEqual;
  const segments = rel.split(/[\\/]/u).filter((segment) => segment.length > 0);
  let cursor = realRoot;
  for (const segment of segments) {
    if (segment === "." || segment === "..") return false;
    cursor = pathOps.join(cursor, segment);
    const entryStat = await fsOps.lstat(cursor);
    if (entryStat.isSymbolicLink()) return false;
  }
  return true;
}

function statKind(info: Stats | BigIntStats): "directory" | "symlink" | "other" | "file" {
  if (info.isSymbolicLink()) return "symlink";
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "other";
}

function cancelledError(): PeerWorkspaceError {
  return {
    ok: false,
    code: "gateway/cancelled",
    message: "The request was cancelled.",
    details: {},
  };
}

function outsideError(displayPath: string): PeerWorkspaceError {
  return {
    ok: false,
    code: "workspace-file/outside-workspace",
    message: `"${displayPath}" is outside the workspace`,
    details: { path: displayPath },
  };
}

/**
 * Validate and resolve one requested path strictly within a Peer thread's workspace root.
 * Shared by workspace file preview RPCs, Office rendering, and original-file downloads.
 */
export async function validatePeerWorkspacePath(input: {
  workspaceRoot: string;
  path: unknown;
  kind: "file" | "directory";
  baseFile?: unknown;
  fsOps?: PeerWorkspaceFsOps;
  signal?: AbortSignal;
}): Promise<PeerWorkspacePathValidation> {
  if (input.signal?.aborted) return cancelledError();
  const fsOps = input.fsOps ?? DEFAULT_FS_OPS;
  const pathOps = pathOpsFor(fsOps.platform);

  if (
    !input.workspaceRoot ||
    /[\u0000-\u001f\u007f]/u.test(input.workspaceRoot) ||
    !pathOps.isAbsolute(input.workspaceRoot)
  ) {
    return {
      ok: false,
      code: "workspace-file/not-found",
      message: "Workspace root is unavailable",
      details: { path: typeof input.path === "string" ? input.path : "" },
    };
  }

  const resolvedRoot = pathOps.resolve(input.workspaceRoot);
  let realRoot: string;
  let pinnedRootStat: Stats | BigIntStats;
  try {
    realRoot = await fsOps.realpath(resolvedRoot);
    pinnedRootStat = await fsOps.lstat(realRoot, { bigint: true });
    if (
      pinnedRootStat.isSymbolicLink() ||
      !pinnedRootStat.isDirectory() ||
      !(await hasNoSymlinkComponentsFromRoot(realRoot, pathOps, fsOps))
    ) {
      return {
        ok: false,
        code: "workspace-file/not-found",
        message: "Workspace root is unavailable",
        details: { path: typeof input.path === "string" ? input.path : "" },
      };
    }
  } catch {
    return {
      ok: false,
      code: "workspace-file/not-found",
      message: "Workspace root is unavailable",
      details: { path: typeof input.path === "string" ? input.path : "" },
    };
  }

  const resolveWithinRoot = async (
    normalized: string,
    expectedKind: "file" | "directory",
    displayPath: string,
  ): Promise<PeerWorkspacePathValidation> => {
    if (input.signal?.aborted) return cancelledError();
    const allowEqual = expectedKind === "directory";
    let mappedCandidate: string;
    if (pathOps.isAbsolute(normalized)) {
      const candidate = pathOps.resolve(normalized);
      if (isPathWithinRoot(candidate, realRoot, fsOps.platform, pathOps, allowEqual)) {
        mappedCandidate = candidate;
      } else if (isPathWithinRoot(candidate, resolvedRoot, fsOps.platform, pathOps, allowEqual)) {
        const rel = pathOps.relative(resolvedRoot, candidate);
        mappedCandidate = rel === "" ? realRoot : pathOps.join(realRoot, rel);
      } else {
        return outsideError(displayPath);
      }
    } else {
      const candidate = pathOps.resolve(realRoot, normalized);
      if (!isPathWithinRoot(candidate, realRoot, fsOps.platform, pathOps, allowEqual)) {
        return outsideError(displayPath);
      }
      mappedCandidate = candidate;
    }

    const relFromRoot = pathOps.relative(realRoot, mappedCandidate);
    const segments = relFromRoot === "" ? [] : relFromRoot.split(/[\\/]/u).filter(Boolean);
    let cursor = realRoot;
    for (let index = 0; index < segments.length; index += 1) {
      if (input.signal?.aborted) return cancelledError();
      const segment = segments[index];
      if (!segment || segment === "." || segment === "..") {
        return outsideError(displayPath);
      }
      cursor = pathOps.join(cursor, segment);
      let entryStat: Stats;
      try {
        entryStat = await fsOps.lstat(cursor);
      } catch (error) {
        if (isErrnoCode(error, "ENOENT", "ENOTDIR")) {
          return {
            ok: false,
            code: "workspace-file/not-found",
            message: `no entry at "${displayPath}"`,
            details: { path: displayPath },
          };
        }
        throw error;
      }
      if (entryStat.isSymbolicLink()) {
        const linkReal = await fsOps.realpath(cursor).catch(() => null);
        if (
          linkReal === null ||
          !isPathWithinRoot(linkReal, realRoot, fsOps.platform, pathOps, allowEqual)
        ) {
          return outsideError(displayPath);
        }
        const isFinal = index === segments.length - 1;
        if (isFinal && expectedKind === "file") {
          return {
            ok: false,
            code: "workspace-file/not-regular-file",
            message: `"${displayPath}" is a symlink`,
            details: { path: displayPath, kind: "symlink" },
          };
        }
      }
    }

    let realPath: string;
    let finalStat: Stats;
    try {
      realPath = await fsOps.realpath(mappedCandidate);
      if (
        !isPathWithinRoot(realPath, realRoot, fsOps.platform, pathOps, allowEqual) ||
        !(await hasNoSymlinkComponentsUnderRoot(realPath, realRoot, pathOps, fsOps, allowEqual))
      ) {
        return outsideError(displayPath);
      }
      finalStat = await fsOps.lstat(realPath);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT", "ENOTDIR")) {
        return {
          ok: false,
          code: "workspace-file/not-found",
          message: `no entry at "${displayPath}"`,
          details: { path: displayPath },
        };
      }
      throw error;
    }

    const kind = statKind(finalStat);
    if (expectedKind === "file" && kind !== "file") {
      return {
        ok: false,
        code: "workspace-file/not-regular-file",
        message: `"${displayPath}" is a ${kind}`,
        details: { path: displayPath, kind },
      };
    }
    if (expectedKind === "directory" && kind !== "directory") {
      return {
        ok: false,
        code: "workspace-file/not-directory",
        message: `"${displayPath}" is a ${kind}`,
        details: { path: displayPath, kind },
      };
    }

    return { ok: true, realRoot, pinnedRootStat, realPath };
  };

  if (input.baseFile !== undefined) {
    const sanitizedBase = sanitizeInputPath(input.baseFile, fsOps.platform);
    if (!sanitizedBase.ok) return sanitizedBase;
    const baseResult = await resolveWithinRoot(
      sanitizedBase.normalized,
      "file",
      String(input.baseFile),
    );
    if (!baseResult.ok) return baseResult;

    if (
      typeof input.path !== "string" ||
      input.path.length === 0 ||
      input.path.length > MAX_PATH_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(input.path)
    ) {
      return {
        ok: false,
        code: "gateway/bad-request",
        message: "path must be relative when baseFile is provided",
        details: {},
      };
    }
    const relativePosix = input.path.replace(/\\/gu, "/");
    if (
      relativePosix.length === 0 ||
      relativePosix.startsWith("/") ||
      /^[a-z][a-z\d+.-]*:/iu.test(relativePosix)
    ) {
      return {
        ok: false,
        code: "gateway/bad-request",
        message: "path must be relative when baseFile is provided",
        details: {},
      };
    }
    const joined = pathOps.resolve(pathOps.dirname(baseResult.realPath), relativePosix);
    return resolveWithinRoot(joined, input.kind, input.path);
  }

  const sanitizedPath = sanitizeInputPath(input.path, fsOps.platform);
  if (!sanitizedPath.ok) return sanitizedPath;
  return resolveWithinRoot(sanitizedPath.normalized, input.kind, String(input.path));
}

/**
 * Open a workspace regular file using `O_NOFOLLOW` and re-verify file-descriptor ownership
 * against the pinned workspace root while holding the open handle (eliminating TOCTOU races).
 */
export async function openConfinedWorkspaceFile(input: {
  workspaceRoot: string;
  path: unknown;
  baseFile?: unknown;
  fsOps?: PeerWorkspaceFsOps;
  signal?: AbortSignal;
}): Promise<{ readonly ok: true; readonly file: ConfinedOpenFile } | PeerWorkspaceError> {
  if (input.signal?.aborted) return cancelledError();
  const fsOps = input.fsOps ?? DEFAULT_FS_OPS;
  const pathOps = pathOpsFor(fsOps.platform);
  const displayPath = typeof input.path === "string" ? input.path : "";

  const validated = await validatePeerWorkspacePath({
    workspaceRoot: input.workspaceRoot,
    path: input.path,
    kind: "file",
    ...(input.baseFile !== undefined ? { baseFile: input.baseFile } : {}),
    fsOps,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!validated.ok) return validated;

  if (input.signal?.aborted) return cancelledError();
  if (fsOps.beforeOpen) await fsOps.beforeOpen(validated.realPath);
  if (input.signal?.aborted) return cancelledError();

  let handle: FileHandle | undefined;
  let keepOpen = false;
  try {
    const preStat = await fsOps.lstat(validated.realPath, { bigint: true });
    if (preStat.isSymbolicLink() || !preStat.isFile()) {
      const kind = statKind(preStat);
      return {
        ok: false,
        code: "workspace-file/not-regular-file",
        message: `"${displayPath}" is a ${kind}`,
        details: { path: displayPath, kind },
      };
    }

    handle = await fsOps.open(validated.realPath, OPEN_READONLY_FLAGS);
    const openedStat = await handle.stat({ bigint: true });
    if (!openedStat.isFile() || !sameFileIdentity(openedStat, preStat)) {
      return outsideError(displayPath);
    }

    // Re-verify real path ownership against the pinned root while holding the open file descriptor.
    if (fsOps.platform === "linux") {
      const fdReal = await fsOps.realpath(`/proc/self/fd/${handle.fd}`);
      const currentRootStat = await fsOps.lstat(validated.realRoot, { bigint: true });
      const fdAllowed =
        !currentRootStat.isSymbolicLink() &&
        currentRootStat.isDirectory() &&
        sameFileIdentity(currentRootStat, validated.pinnedRootStat) &&
        isPathWithinRoot(fdReal, validated.realRoot, fsOps.platform, pathOps, false) &&
        (await hasNoSymlinkComponentsFromRoot(fdReal, pathOps, fsOps));
      if (!fdAllowed || !sameFileIdentity(await fsOps.stat(fdReal, { bigint: true }), openedStat)) {
        return outsideError(displayPath);
      }
    } else {
      const postRoot = await fsOps.realpath(input.workspaceRoot);
      const postReal = await fsOps.realpath(validated.realPath);
      const currentRootStat = await fsOps.lstat(validated.realRoot, { bigint: true });
      const postAllowed =
        postRoot === validated.realRoot &&
        postReal === validated.realPath &&
        !currentRootStat.isSymbolicLink() &&
        currentRootStat.isDirectory() &&
        sameFileIdentity(currentRootStat, validated.pinnedRootStat) &&
        isPathWithinRoot(postReal, validated.realRoot, fsOps.platform, pathOps, false) &&
        (await hasNoSymlinkComponentsFromRoot(postReal, pathOps, fsOps));
      if (
        !postAllowed ||
        !sameFileIdentity(await fsOps.stat(postReal, { bigint: true }), openedStat)
      ) {
        return outsideError(displayPath);
      }
    }

    keepOpen = true;
    return {
      ok: true,
      file: {
        handle,
        realRoot: validated.realRoot,
        realPath: validated.realPath,
        size: Number(openedStat.size),
        version: versionOf(openedStat),
      },
    };
  } catch (error) {
    if (isErrnoCode(error, "ELOOP")) return outsideError(displayPath);
    if (isErrnoCode(error, "ENOENT", "ENOTDIR")) {
      return {
        ok: false,
        code: "workspace-file/not-found",
        message: `no entry at "${displayPath}"`,
        details: { path: displayPath },
      };
    }
    return outsideError(displayPath);
  } finally {
    if (!keepOpen) await handle?.close();
  }
}

export async function readHandleExactRange(
  handle: FileHandle,
  offset: number,
  maxBytes: number,
  options: { rejectOnOverflow: boolean; signal?: AbortSignal },
): Promise<{ readonly bytes: Buffer; readonly overflowed: boolean; readonly eof: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let position = offset;
  const targetLimit = options.rejectOnOverflow ? maxBytes + 1 : maxBytes;
  while (total < targetLimit) {
    if (options.signal?.aborted) throw new Error("aborted");
    const want = Math.min(PEER_FILE_LIMITS.readChunkBytes, targetLimit - total);
    const buf = Buffer.allocUnsafe(want);
    const { bytesRead } = await handle.read(buf, 0, want, position);
    if (bytesRead === 0) {
      return { bytes: Buffer.concat(chunks, total), overflowed: false, eof: true };
    }
    position += bytesRead;
    total += bytesRead;
    if (options.rejectOnOverflow && total > maxBytes) {
      return { bytes: Buffer.alloc(0), overflowed: true, eof: false };
    }
    chunks.push(bytesRead === want ? buf : buf.subarray(0, bytesRead));
  }
  return { bytes: Buffer.concat(chunks, total), overflowed: false, eof: false };
}

export async function statConfinedWorkspaceFile(input: {
  workspaceRoot: string;
  path: unknown;
  fsOps?: PeerWorkspaceFsOps;
  signal?: AbortSignal;
}): Promise<
  | { readonly ok: true; readonly value: { absolutePath: string; version: string; bytes: number } }
  | PeerWorkspaceError
> {
  const opened = await openConfinedWorkspaceFile(input);
  if (!opened.ok) return opened;
  try {
    return {
      ok: true,
      value: {
        absolutePath: opened.file.realPath,
        version: opened.file.version,
        bytes: opened.file.size,
      },
    };
  } finally {
    await opened.file.handle.close();
  }
}

function parseSafeInt(value: unknown, min: number, name: string): number | PeerWorkspaceError {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    return {
      ok: false,
      code: "gateway/bad-request",
      message: `${name} must be a safe integer of at least ${min}`,
      details: {},
    };
  }
  return value;
}

export async function readConfinedWorkspaceText(input: {
  workspaceRoot: string;
  path: unknown;
  range?: Record<string, unknown>;
  fsOps?: PeerWorkspaceFsOps;
  signal?: AbortSignal;
}): Promise<{ readonly ok: true; readonly value: ConfinedTextPage } | PeerWorkspaceError> {
  const rawOffset = input.range?.offset;
  const rawLimit = input.range?.limit;
  const offset = rawOffset === undefined ? 1 : parseSafeInt(rawOffset, 1, "offset");
  if (typeof offset !== "number") return offset;
  const limit =
    rawLimit === undefined ? PEER_FILE_LIMITS.maxTextLines : parseSafeInt(rawLimit, 1, "limit");
  if (typeof limit !== "number") return limit;
  if (limit > PEER_FILE_LIMITS.maxTextLines) {
    return {
      ok: false,
      code: "gateway/bad-request",
      message: `limit must be at most ${PEER_FILE_LIMITS.maxTextLines}`,
      details: {},
    };
  }

  const opened = await openConfinedWorkspaceFile(input);
  if (!opened.ok) return opened;
  const displayPath = typeof input.path === "string" ? input.path : opened.file.realPath;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const last = offset + limit - 1;
    const lines: string[] = [];
    let current = "";
    let pageBytes = 0;
    let lineNumber = 1;
    let reachedPastPage = false;

    const admitBytes = (size: number): PeerWorkspaceError | undefined => {
      pageBytes += size;
      if (pageBytes > PEER_FILE_LIMITS.maxTextPageBytes) {
        return {
          ok: false,
          code: "workspace-file/too-large",
          message: `lines ${offset}-${last} of "${displayPath}" exceed the ${PEER_FILE_LIMITS.maxTextPageBytes} byte cap`,
          details: { path: displayPath, limit: PEER_FILE_LIMITS.maxTextPageBytes },
        };
      }
      return undefined;
    };

    const feedChunk = (textChunk: string): PeerWorkspaceError | undefined => {
      let pos = 0;
      while (pos < textChunk.length) {
        if (lineNumber > last) {
          reachedPastPage = true;
          return undefined;
        }
        const newline = textChunk.indexOf("\n", pos);
        const segment = newline === -1 ? textChunk.slice(pos) : textChunk.slice(pos, newline);
        if (lineNumber >= offset) {
          if (segment.includes("\0")) {
            return {
              ok: false,
              code: "workspace-file/not-text",
              message: `"${displayPath}" contains NUL bytes`,
              details: { path: displayPath },
            };
          }
          const err = admitBytes(Buffer.byteLength(segment, "utf8"));
          if (err) return err;
          current += segment;
        }
        if (newline === -1) break;
        if (lineNumber >= offset) {
          if (lines.length > 0) {
            const nlErr = admitBytes(1);
            if (nlErr) return nlErr;
          }
          lines.push(current);
          current = "";
        }
        lineNumber += 1;
        pos = newline + 1;
      }
      return undefined;
    };

    const buf = Buffer.allocUnsafe(PEER_FILE_LIMITS.readChunkBytes);
    let position = 0;
    for (;;) {
      if (input.signal?.aborted) return cancelledError();
      const { bytesRead } = await opened.file.handle.read(buf, 0, buf.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      let decoded: string;
      try {
        decoded = decoder.decode(buf.subarray(0, bytesRead), { stream: true });
      } catch {
        return {
          ok: false,
          code: "workspace-file/not-text",
          message: `"${displayPath}" is not UTF-8 text`,
          details: { path: displayPath },
        };
      }
      const err = feedChunk(decoded);
      if (err) return err;
      if (reachedPastPage) break;
    }

    if (!reachedPastPage) {
      let tail: string;
      try {
        tail = decoder.decode();
      } catch {
        return {
          ok: false,
          code: "workspace-file/not-text",
          message: `"${displayPath}" is not UTF-8 text`,
          details: { path: displayPath },
        };
      }
      if (tail.length > 0) {
        const err = feedChunk(tail);
        if (err) return err;
      }
    }

    if (!reachedPastPage && current.length > 0) {
      if (lines.length > 0) {
        const nlErr = admitBytes(1);
        if (nlErr) return nlErr;
      }
      lines.push(current);
    }

    return {
      ok: true,
      value: {
        absolutePath: opened.file.realPath,
        version: opened.file.version,
        bytes: opened.file.size,
        offset,
        text: lines.join("\n"),
        lines: lines.length,
        eof: !reachedPastPage,
      },
    };
  } finally {
    await opened.file.handle.close();
  }
}

export async function readConfinedWorkspaceBytes(input: {
  workspaceRoot: string;
  path: unknown;
  options?: Record<string, unknown>;
  fsOps?: PeerWorkspaceFsOps;
  signal?: AbortSignal;
}): Promise<{ readonly ok: true; readonly value: ConfinedFileBytes } | PeerWorkspaceError> {
  const displayPath = typeof input.path === "string" ? input.path : "";
  const rawRange =
    input.options && typeof input.options.range === "object" && input.options.range !== null
      ? (input.options.range as Record<string, unknown>)
      : undefined;
  let window: { offset: number; length: number } | undefined;
  if (rawRange !== undefined) {
    const offset = rawRange.offset === undefined ? 0 : parseSafeInt(rawRange.offset, 0, "offset");
    if (typeof offset !== "number") return offset;
    const length =
      rawRange.length === undefined
        ? PEER_FILE_LIMITS.maxByteRangeBytes
        : parseSafeInt(rawRange.length, 1, "length");
    if (typeof length !== "number") return length;
    if (offset + length > Number.MAX_SAFE_INTEGER) {
      return {
        ok: false,
        code: "gateway/bad-request",
        message: "offset plus length must stay a safe integer",
        details: {},
      };
    }
    if (length > PEER_FILE_LIMITS.maxByteRangeBytes) {
      return {
        ok: false,
        code: "workspace-file/too-large",
        message: `${length} bytes of "${displayPath}" exceed the ${PEER_FILE_LIMITS.maxByteRangeBytes} byte cap`,
        details: { path: displayPath, limit: PEER_FILE_LIMITS.maxByteRangeBytes },
      };
    }
    window = { offset, length };
  }

  const baseFile = input.options?.baseFile;
  const opened = await openConfinedWorkspaceFile({
    workspaceRoot: input.workspaceRoot,
    path: input.path,
    ...(baseFile !== undefined ? { baseFile } : {}),
    ...(input.fsOps ? { fsOps: input.fsOps } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!opened.ok) return opened;
  try {
    if (window !== undefined) {
      const read = await readHandleExactRange(opened.file.handle, window.offset, window.length, {
        rejectOnOverflow: false,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const eof = read.eof || window.offset + read.bytes.length >= opened.file.size;
      return {
        ok: true,
        value: {
          absolutePath: opened.file.realPath,
          version: opened.file.version,
          bytes: opened.file.size,
          offset: window.offset,
          data: read.bytes,
          eof,
        },
      };
    }
    if (opened.file.size > PEER_FILE_LIMITS.maxFullFileBytes) {
      return {
        ok: false,
        code: "workspace-file/too-large",
        message: `"${displayPath}" exceeds the ${PEER_FILE_LIMITS.maxFullFileBytes} byte full-file cap`,
        details: { path: displayPath, limit: PEER_FILE_LIMITS.maxFullFileBytes },
      };
    }
    const read = await readHandleExactRange(
      opened.file.handle,
      0,
      PEER_FILE_LIMITS.maxFullFileBytes,
      {
        rejectOnOverflow: true,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    if (read.overflowed) {
      return {
        ok: false,
        code: "workspace-file/too-large",
        message: `"${displayPath}" exceeds the ${PEER_FILE_LIMITS.maxFullFileBytes} byte full-file cap`,
        details: { path: displayPath, limit: PEER_FILE_LIMITS.maxFullFileBytes },
      };
    }
    return {
      ok: true,
      value: {
        absolutePath: opened.file.realPath,
        version: opened.file.version,
        bytes: opened.file.size,
        offset: 0,
        data: read.bytes,
        eof: true,
      },
    };
  } catch {
    if (input.signal?.aborted) return cancelledError();
    return {
      ok: false,
      code: "workspace-file/not-found",
      message: `no entry at "${displayPath}"`,
      details: { path: displayPath },
    };
  } finally {
    await opened.file.handle.close();
  }
}

export async function listConfinedWorkspaceDirectory(input: {
  workspaceRoot: string;
  path: unknown;
  fsOps?: PeerWorkspaceFsOps;
  signal?: AbortSignal;
}): Promise<{ readonly ok: true; readonly value: ConfinedDirectoryListing } | PeerWorkspaceError> {
  if (input.signal?.aborted) return cancelledError();
  const fsOps = input.fsOps ?? DEFAULT_FS_OPS;
  const pathOps = pathOpsFor(fsOps.platform);
  const displayPath = typeof input.path === "string" ? input.path : "";
  const validated = await validatePeerWorkspacePath({
    workspaceRoot: input.workspaceRoot,
    path: input.path,
    kind: "directory",
    fsOps,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!validated.ok) return validated;
  if (input.signal?.aborted) return cancelledError();
  if (fsOps.beforeOpen) await fsOps.beforeOpen(validated.realPath);
  if (input.signal?.aborted) return cancelledError();

  try {
    const preStat = await fsOps.lstat(validated.realPath, { bigint: true });
    if (preStat.isSymbolicLink() || !preStat.isDirectory()) {
      return outsideError(displayPath);
    }
    const postRoot = await fsOps.realpath(input.workspaceRoot);
    const postReal = await fsOps.realpath(validated.realPath);
    const currentRootStat = await fsOps.lstat(validated.realRoot, { bigint: true });
    if (
      postRoot !== validated.realRoot ||
      postReal !== validated.realPath ||
      currentRootStat.isSymbolicLink() ||
      !currentRootStat.isDirectory() ||
      !sameFileIdentity(currentRootStat, validated.pinnedRootStat) ||
      !(await hasNoSymlinkComponentsFromRoot(postReal, pathOps, fsOps))
    ) {
      return outsideError(displayPath);
    }

    const readDirFn = fsOps.readdir ?? readdir;
    const dirents = await readDirFn(validated.realPath, { withFileTypes: true, encoding: "utf8" });
    if (input.signal?.aborted) return cancelledError();

    // Post-readdir identity check to guard against directory swap during enumeration.
    const afterReal = await fsOps.realpath(validated.realPath);
    const afterStat = await fsOps.lstat(validated.realPath, { bigint: true });
    if (afterReal !== validated.realPath || !sameFileIdentity(afterStat, preStat)) {
      return outsideError(displayPath);
    }

    const sorted = [...dirents].sort((a, b) => a.name.localeCompare(b.name));
    const truncated = sorted.length > PEER_FILE_LIMITS.maxDirectoryEntries;
    const bounded = sorted.slice(0, PEER_FILE_LIMITS.maxDirectoryEntries);
    const entries: ConfinedDirectoryEntry[] = [];
    for (const dirent of bounded) {
      if (input.signal?.aborted) return cancelledError();
      const childPath = pathOps.join(validated.realPath, dirent.name);
      if (dirent.isDirectory()) {
        entries.push({ name: dirent.name, type: "directory" });
      } else if (dirent.isFile()) {
        const info = await fsOps.lstat(childPath).catch(() => undefined);
        entries.push({
          name: dirent.name,
          type: "file",
          ...(info?.isFile() ? { size: info.size } : {}),
        });
      } else if (dirent.isSymbolicLink()) {
        const targetReal = await fsOps.realpath(childPath).catch(() => null);
        if (
          targetReal !== null &&
          isPathWithinRoot(targetReal, validated.realRoot, fsOps.platform, pathOps, false)
        ) {
          const info = await fsOps.stat(targetReal).catch(() => undefined);
          if (info?.isDirectory()) {
            entries.push({ name: dirent.name, type: "directory" });
          } else if (info?.isFile()) {
            entries.push({ name: dirent.name, type: "file", size: info.size });
          } else {
            entries.push({ name: dirent.name, type: "other" });
          }
        } else {
          entries.push({ name: dirent.name, type: "other" });
        }
      } else {
        entries.push({ name: dirent.name, type: "other" });
      }
    }

    const rel = pathOps.relative(validated.realRoot, validated.realPath);
    const workspaceRelPosix = rel === "" ? "" : rel.split(/[\\/]/u).join("/");
    return {
      ok: true,
      value: {
        path: workspaceRelPosix,
        entries,
        truncated,
      },
    };
  } catch (error) {
    if (isErrnoCode(error, "ENOENT", "ENOTDIR")) {
      return {
        ok: false,
        code: "workspace-file/not-found",
        message: `no entry at "${displayPath}"`,
        details: { path: displayPath },
      };
    }
    return outsideError(displayPath);
  }
}
