/** Peer workspace-file HTTP endpoints (`/api/peer/v1/workspace-files/rpc|download`), called after auth and same-origin gates. */
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { posix, win32 } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

export const PEER_WORKSPACE_FILES_HEADER = "x-codexhost-peer-workspace-files";

export const PEER_WORKSPACE_FILE_METHODS = new Set<string>([
  "workspaceFiles/read",
  "workspaceFiles/readBytes",
  "workspaceFiles/stat",
  "workspaceFiles/list",
  "officeToPdf/render",
]);

export type PeerWorkspaceFilesRoute = "rpc" | "download";

export type PeerWorkspacePathErrorCode =
  | "gateway/bad-request"
  | "workspace-file/outside-workspace"
  | "workspace-file/not-found"
  | "workspace-file/not-regular-file"
  | "workspace-file/not-directory";

export type PeerWorkspacePathValidation =
  | {
      readonly ok: true;
      readonly realRoot: string;
      readonly pinnedRootStat: Stats;
      readonly realPath: string;
    }
  | {
      readonly ok: false;
      readonly code: PeerWorkspacePathErrorCode;
      readonly message: string;
      readonly details: Record<string, unknown>;
    };

export interface PeerWorkspaceFsOps {
  readonly lstat: typeof lstat;
  readonly stat: typeof stat;
  readonly open: typeof open;
  readonly realpath: typeof realpath;
  readonly platform: NodeJS.Platform;
}

export interface PeerWorkspaceFilesDsh {
  fetchMethod(method: string, body: string, signal: AbortSignal): Promise<Response | undefined>;
}

export interface PeerWorkspaceFilesDeps {
  resolveWorkspaceRoot(threadId: string): Promise<string | undefined> | string | undefined;
  dsh?: PeerWorkspaceFilesDsh;
  fsOps?: PeerWorkspaceFsOps;
}

const DEFAULT_FS_OPS: PeerWorkspaceFsOps = {
  lstat,
  stat,
  open,
  realpath,
  platform: process.platform,
};

const MAX_RPC_BODY_BYTES = 1024 * 1024;
const MAX_PATH_LENGTH = 8192;
const OPEN_READONLY_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const SAFE_DOWNLOAD_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
  [PEER_WORKSPACE_FILES_HEADER]: "1",
} as const;

type PathOps = typeof posix | typeof win32;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoCode(error: unknown, ...codes: string[]): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && codes.includes(code);
}

function sameFileIdentity(
  left: Pick<Stats, "dev" | "ino">,
  right: Pick<Stats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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
):
  | { readonly ok: true; readonly normalized: string }
  | {
      readonly ok: false;
      readonly code: PeerWorkspacePathErrorCode;
      readonly message: string;
      readonly details: Record<string, unknown>;
    } {
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

function statKind(info: Stats): "directory" | "symlink" | "other" | "file" {
  if (info.isSymbolicLink()) return "symlink";
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "other";
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
}): Promise<PeerWorkspacePathValidation> {
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
  let pinnedRootStat: Stats;
  try {
    realRoot = await fsOps.realpath(resolvedRoot);
    pinnedRootStat = await fsOps.lstat(realRoot);
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
        return {
          ok: false,
          code: "workspace-file/outside-workspace",
          message: `"${displayPath}" is outside the workspace`,
          details: { path: displayPath },
        };
      }
    } else {
      const candidate = pathOps.resolve(realRoot, normalized);
      if (!isPathWithinRoot(candidate, realRoot, fsOps.platform, pathOps, allowEqual)) {
        return {
          ok: false,
          code: "workspace-file/outside-workspace",
          message: `"${displayPath}" is outside the workspace`,
          details: { path: displayPath },
        };
      }
      mappedCandidate = candidate;
    }

    // Walk every component from realRoot to mappedCandidate to catch escaping or disallowed symlinks
    // before resolving the final target, avoiding existence leaks outside the workspace.
    const relFromRoot = pathOps.relative(realRoot, mappedCandidate);
    const segments = relFromRoot === "" ? [] : relFromRoot.split(/[\\/]/u).filter(Boolean);
    let cursor = realRoot;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!segment || segment === "." || segment === "..") {
        return {
          ok: false,
          code: "workspace-file/outside-workspace",
          message: `"${displayPath}" is outside the workspace`,
          details: { path: displayPath },
        };
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
          return {
            ok: false,
            code: "workspace-file/outside-workspace",
            message: `"${displayPath}" is outside the workspace`,
            details: { path: displayPath },
          };
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
        return {
          ok: false,
          code: "workspace-file/outside-workspace",
          message: `"${displayPath}" is outside the workspace`,
          details: { path: displayPath },
        };
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
      input.path.length > MAX_PATH_LENGTH
    ) {
      return {
        ok: false,
        code: "gateway/bad-request",
        message: "path must be relative when baseFile is provided",
        details: {},
      };
    }
    if (/[\u0000-\u001f\u007f]/u.test(input.path)) {
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

function sendTypertError(
  response: ServerResponse,
  rpcId: string,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  status = 200,
): void {
  if (response.destroyed || response.writableEnded || response.headersSent) return;
  const payload = Buffer.from(
    JSON.stringify({
      type: "server-response",
      rpcId,
      result: {
        ok: false,
        error: { code, message, details },
      },
    }),
  );
  response
    .writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(payload.byteLength),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      [PEER_WORKSPACE_FILES_HEADER]: "1",
    })
    .end(payload);
}

function sendPlain(
  response: ServerResponse,
  status: number,
  message: string,
  isHead = false,
): void {
  if (response.destroyed || response.writableEnded || response.headersSent) return;
  response
    .writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      ...SAFE_DOWNLOAD_HEADERS,
    })
    .end(isHead ? undefined : message);
}

async function readBoundedRpcBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<string | undefined> {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_RPC_BODY_BYTES) {
    sendTypertError(
      response,
      "invalid-request",
      "gateway/bad-request",
      "Request body too large",
      {},
      413,
    );
    request.resume();
    return undefined;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.byteLength;
    if (total > MAX_RPC_BODY_BYTES) {
      sendTypertError(
        response,
        "invalid-request",
        "gateway/bad-request",
        "Request body too large",
        {},
        413,
      );
      request.resume();
      return undefined;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function encodeContentDisposition(fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/gu,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="download"; filename*=UTF-8''${encoded}`;
}

async function handleRpc(
  request: IncomingMessage,
  response: ServerResponse,
  deps: PeerWorkspaceFilesDeps,
): Promise<void> {
  if (request.method !== "POST") {
    sendPlain(response, 405, "method not allowed");
    request.resume();
    return;
  }
  const rawBody = await readBoundedRpcBody(request, response);
  if (rawBody === undefined) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    sendTypertError(
      response,
      "invalid-request",
      "gateway/bad-request",
      "Body is not valid JSON",
      {},
      400,
    );
    return;
  }
  if (!isPlainObject(parsed)) {
    sendTypertError(
      response,
      "invalid-request",
      "gateway/bad-request",
      "Invalid client-request message",
    );
    return;
  }
  const rpcId =
    typeof parsed.rpcId === "string" && parsed.rpcId.length > 0 ? parsed.rpcId : "invalid-request";
  const method = parsed.method;
  if (
    parsed.type !== "client-request" ||
    typeof method !== "string" ||
    !PEER_WORKSPACE_FILE_METHODS.has(method)
  ) {
    sendTypertError(
      response,
      rpcId,
      "gateway/bad-request",
      "Requested method is not allowed on peer workspace-files endpoint",
    );
    return;
  }
  if (!deps.dsh) {
    sendTypertError(
      response,
      rpcId,
      "gateway/service-unavailable",
      "Remote workspace file service is unavailable on this peer",
    );
    return;
  }

  const payload = isPlainObject(parsed.payload) ? parsed.payload : undefined;
  const args = payload && isPlainObject(payload.args) ? payload.args : undefined;
  const threadId =
    args && typeof args.workspaceFileScopeId === "string" ? args.workspaceFileScopeId : "";
  if (!threadId || threadId.length > 1024) {
    sendTypertError(response, rpcId, "gateway/bad-request", "workspaceFileScopeId is required");
    return;
  }

  const workspaceRoot = await deps.resolveWorkspaceRoot(threadId);
  if (!workspaceRoot) {
    sendTypertError(
      response,
      rpcId,
      "gateway/lookup-not-found",
      "Remote thread workspace is unavailable",
    );
    return;
  }

  const readBytesOptions =
    method === "workspaceFiles/readBytes" && isPlainObject(args?.options)
      ? args.options
      : undefined;
  const baseFile = readBytesOptions?.baseFile;
  let validated: PeerWorkspacePathValidation;
  try {
    validated = await validatePeerWorkspacePath({
      workspaceRoot,
      path: args?.path,
      kind: method === "workspaceFiles/list" ? "directory" : "file",
      ...(baseFile !== undefined ? { baseFile } : {}),
      ...(deps.fsOps ? { fsOps: deps.fsOps } : {}),
    });
  } catch (error) {
    sendTypertError(
      response,
      rpcId,
      "gateway/internal",
      error instanceof Error ? error.message : "Failed to validate workspace path",
    );
    return;
  }
  if (!validated.ok) {
    sendTypertError(response, rpcId, validated.code, validated.message, validated.details);
    return;
  }

  const nextArgs: Record<string, unknown> = {
    ...args,
    workspaceFileScopeId: threadId,
    path: validated.realPath,
  };
  if (
    method === "workspaceFiles/readBytes" &&
    readBytesOptions !== undefined &&
    baseFile !== undefined
  ) {
    const restOptions = { ...readBytesOptions };
    delete restOptions.baseFile;
    nextArgs.options = restOptions;
  }
  const forwardedBody = JSON.stringify({
    type: "client-request",
    rpcId,
    method,
    payload: { ...payload, args: nextArgs },
  });

  const lifetime = new AbortController();
  const abort = (): void => {
    if (!response.writableEnded) lifetime.abort(new Error("Peer RPC connection closed"));
  };
  response.once("close", abort);
  request.once("aborted", abort);
  try {
    const answered = await deps.dsh.fetchMethod(method, forwardedBody, lifetime.signal);
    if (lifetime.signal.aborted || response.destroyed) return;
    if (!answered) {
      sendTypertError(
        response,
        rpcId,
        "gateway/service-unavailable",
        "Remote workspace file service is unavailable on this peer",
      );
      return;
    }
    const headers: Record<string, string> = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      [PEER_WORKSPACE_FILES_HEADER]: "1",
    };
    const contentType = answered.headers.get("content-type");
    if (contentType) headers["content-type"] = contentType;
    const contentLength = answered.headers.get("content-length");
    if (contentLength) headers["content-length"] = contentLength;
    response.writeHead(answered.status, headers);
    if (answered.body === null) {
      response.end();
      return;
    }
    await pipeline(Readable.fromWeb(answered.body as WebReadableStream<Uint8Array>), response);
  } catch (error) {
    if (lifetime.signal.aborted || response.destroyed || response.writableEnded) return;
    if (!response.headersSent) {
      sendTypertError(
        response,
        rpcId,
        "gateway/internal",
        error instanceof Error ? error.message : "Peer workspace file request failed",
      );
    } else {
      response.destroy();
    }
  } finally {
    response.off("close", abort);
    request.off("aborted", abort);
  }
}

async function handleDownload(
  request: IncomingMessage,
  response: ServerResponse,
  deps: PeerWorkspaceFilesDeps,
): Promise<void> {
  const isHead = request.method === "HEAD";
  if (request.method !== "GET" && !isHead) {
    sendPlain(response, 405, "method not allowed");
    request.resume();
    return;
  }
  const url = new URL(request.url ?? "/", "http://localhost");
  const threadId = url.searchParams.get("threadId");
  const rawPath = url.searchParams.get("path");
  if (!threadId || !rawPath) {
    sendPlain(response, 400, "missing parameters", isHead);
    return;
  }
  const workspaceRoot = await deps.resolveWorkspaceRoot(threadId);
  if (!workspaceRoot) {
    sendPlain(response, 404, "file unavailable", isHead);
    return;
  }
  const fsOps = deps.fsOps ?? DEFAULT_FS_OPS;
  const pathOps = pathOpsFor(fsOps.platform);
  let validated: PeerWorkspacePathValidation;
  try {
    validated = await validatePeerWorkspacePath({
      workspaceRoot,
      path: rawPath,
      kind: "file",
      fsOps,
    });
  } catch {
    sendPlain(response, 404, "file unavailable", isHead);
    return;
  }
  if (!validated.ok) {
    const status =
      validated.code === "workspace-file/outside-workspace"
        ? 403
        : validated.code === "gateway/bad-request"
          ? 400
          : 404;
    sendPlain(
      response,
      status,
      validated.code === "workspace-file/outside-workspace"
        ? "outside workspace"
        : "file unavailable",
      isHead,
    );
    return;
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const preStat = await fsOps.lstat(validated.realPath);
    if (preStat.isSymbolicLink() || !preStat.isFile()) {
      sendPlain(response, 404, "file unavailable", isHead);
      return;
    }
    handle = await fsOps.open(validated.realPath, OPEN_READONLY_FLAGS);
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || !sameFileIdentity(openedStat, preStat)) {
      sendPlain(response, 404, "file unavailable", isHead);
      return;
    }

    // Re-verify real path ownership while holding the open file descriptor.
    if (fsOps.platform === "linux") {
      const fdReal = await fsOps.realpath(`/proc/self/fd/${handle.fd}`);
      const currentRootStat = await fsOps.lstat(validated.realRoot);
      const fdAllowed =
        !currentRootStat.isSymbolicLink() &&
        currentRootStat.isDirectory() &&
        sameFileIdentity(currentRootStat, validated.pinnedRootStat) &&
        isPathWithinRoot(fdReal, validated.realRoot, fsOps.platform, pathOps, false) &&
        (await hasNoSymlinkComponentsFromRoot(fdReal, pathOps, fsOps));
      if (!fdAllowed || !sameFileIdentity(await fsOps.stat(fdReal), openedStat)) {
        sendPlain(response, 403, "outside workspace", isHead);
        return;
      }
    } else {
      const postRoot = await fsOps.realpath(workspaceRoot);
      const postReal = await fsOps.realpath(validated.realPath);
      const currentRootStat = await fsOps.lstat(validated.realRoot);
      const postAllowed =
        postRoot === validated.realRoot &&
        postReal === validated.realPath &&
        !currentRootStat.isSymbolicLink() &&
        currentRootStat.isDirectory() &&
        sameFileIdentity(currentRootStat, validated.pinnedRootStat) &&
        isPathWithinRoot(postReal, validated.realRoot, fsOps.platform, pathOps, false) &&
        (await hasNoSymlinkComponentsFromRoot(postReal, pathOps, fsOps));
      if (!postAllowed || !sameFileIdentity(await fsOps.stat(postReal), openedStat)) {
        sendPlain(response, 403, "outside workspace", isHead);
        return;
      }
    }

    const fileName = pathOps.basename(validated.realPath) || "download";
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": encodeContentDisposition(fileName),
      "Content-Length": String(openedStat.size),
      ...SAFE_DOWNLOAD_HEADERS,
    });
    if (isHead || openedStat.size === 0) {
      response.end();
      return;
    }
    await pipeline(
      handle.createReadStream({ autoClose: false, end: Math.max(0, openedStat.size - 1) }),
      response,
    );
  } catch {
    if (!response.headersSent && !response.destroyed && !response.writableEnded) {
      sendPlain(response, 404, "file unavailable", isHead);
    } else if (!response.destroyed) {
      response.destroy();
    }
  } finally {
    await handle?.close();
  }
}

export async function servePeerWorkspaceFiles(
  request: IncomingMessage,
  response: ServerResponse,
  route: PeerWorkspaceFilesRoute,
  deps: PeerWorkspaceFilesDeps,
): Promise<void> {
  if (route === "rpc") return handleRpc(request, response, deps);
  return handleDownload(request, response, deps);
}
