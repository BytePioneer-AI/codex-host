/** Peer attachment HTTP endpoints (`/api/peer/v1/uploads|prompt|file`), called after auth and same-origin gates. */
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import * as c from "@codexhost/shared-contracts";
import type { ChSessions } from "./ch-sessions.ts";
import { RpcError, type RpcRegistry } from "./transport.ts";
import type { WebFiles } from "./web-files.ts";
import { inspectImage, WEB_IMAGE_LIMITS, type WebImages } from "./web-images.ts";

export type PeerAttachmentsRoute = "uploads" | "prompt" | "file";

export interface PeerAttachmentsDeps {
  sessions: Pick<ChSessions, "uploadFile" | "localWorkspaceRoot">;
  files: Pick<WebFiles, "upload" | "bind" | "reference">;
  images: Pick<WebImages, "idForPath">;
  rpc: Pick<RpcRegistry, "dispatch">;
}

const MAX_PROMPT_BODY_BYTES = 16 * 1024 * 1024;
const PEER_UPLOAD_SCOPE_PREFIX = "peer-upload:";

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response
    .writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    })
    .end(JSON.stringify(body));
}

function sendPlain(
  response: ServerResponse,
  status: number,
  message: string,
  isHead = false,
): void {
  response
    .writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
    })
    .end(isHead ? undefined : message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorEnvelope(error: unknown, fallbackMessage: string) {
  const details =
    error instanceof RpcError && isPlainObject(error.details) ? error.details : undefined;
  return {
    ok: false as const,
    error: {
      code: error instanceof RpcError ? error.code : "gateway/internal",
      message: error instanceof Error ? error.message : fallbackMessage,
      ...(details !== undefined ? { details } : {}),
    },
  };
}

const OPEN_READONLY_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export interface VerifiedFileFsOps {
  lstat: typeof lstat;
  stat: typeof stat;
  open: typeof open;
  realpath: typeof realpath;
  platform: NodeJS.Platform;
}

const DEFAULT_FS_OPS: VerifiedFileFsOps = {
  lstat,
  stat,
  open,
  realpath,
  platform: process.platform,
};

function isPathWithinRoot(candidate: string, root: string, platform = process.platform): boolean {
  const normCandidate = platform === "win32" ? candidate.toLowerCase() : candidate;
  const normRoot = platform === "win32" ? root.toLowerCase() : root;
  const rel = relative(normRoot, normCandidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function hasNoSymlinkComponentsUnderRoot(
  targetPath: string,
  rootPath: string,
  fsOps: VerifiedFileFsOps,
): Promise<boolean> {
  if (!isPathWithinRoot(targetPath, rootPath, fsOps.platform)) return false;
  const rel = relative(rootPath, targetPath);
  const segments = rel.split(/[\\/]/u).filter((segment) => segment.length > 0);
  if (segments.length === 0) return false;
  let cursor = rootPath;
  for (const segment of segments) {
    if (segment === "." || segment === "..") return false;
    cursor = join(cursor, segment);
    const entryStat = await fsOps.lstat(cursor);
    if (entryStat.isSymbolicLink()) return false;
  }
  return true;
}

function isWebStoragePath(
  targetPath: string,
  deps: Pick<PeerAttachmentsDeps, "files" | "images">,
): boolean {
  return (
    deps.files.reference(targetPath) !== undefined ||
    deps.images.idForPath(targetPath) !== undefined
  );
}

async function verifyWebStorageComponents(
  targetPath: string,
  deps: Pick<PeerAttachmentsDeps, "files" | "images">,
  fsOps: VerifiedFileFsOps,
): Promise<boolean> {
  if (!isWebStoragePath(targetPath, deps)) return false;
  const parent = dirname(targetPath);
  const [parentStat, targetStat, parentReal] = await Promise.all([
    fsOps.lstat(parent),
    fsOps.lstat(targetPath),
    fsOps.realpath(parent),
  ]);
  if (parentStat.isSymbolicLink() || targetStat.isSymbolicLink()) return false;
  if (parentReal !== parent) return false;
  return true;
}

async function hasNoSymlinkComponentsFromRoot(
  canonicalPath: string,
  fsOps: VerifiedFileFsOps,
): Promise<boolean> {
  const parsed = parse(canonicalPath);
  if (!parsed.root) return false;
  const rel = relative(parsed.root, canonicalPath);
  const segments = rel.split(/[\\/]/u).filter((segment) => segment.length > 0);
  let cursor = parsed.root;
  for (const segment of segments) {
    if (segment === "." || segment === "..") return false;
    cursor = join(cursor, segment);
    const entryStat = await fsOps.lstat(cursor);
    if (entryStat.isSymbolicLink()) return false;
  }
  return true;
}

function sameFileIdentity(
  left: Pick<Awaited<ReturnType<typeof stat>>, "dev" | "ino">,
  right: Pick<Awaited<ReturnType<typeof stat>>, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function readVerifiedAttachmentFile(
  candidate: string,
  workspaceRoot: string,
  deps: Pick<PeerAttachmentsDeps, "files" | "images">,
  fsOps: VerifiedFileFsOps = DEFAULT_FS_OPS,
): Promise<Buffer | "too-large" | "missing"> {
  let realTarget: string;
  try {
    realTarget = await fsOps.realpath(candidate);
  } catch {
    return "missing";
  }

  let realRoot: string | undefined;
  let pinnedRootStat: Awaited<ReturnType<typeof lstat>> | undefined;
  let inWorkspace = false;
  if (workspaceRoot) {
    try {
      realRoot = await fsOps.realpath(workspaceRoot);
      const rootStat = await fsOps.lstat(realRoot);
      if (
        !rootStat.isSymbolicLink() &&
        rootStat.isDirectory() &&
        isPathWithinRoot(realTarget, realRoot, fsOps.platform)
      ) {
        pinnedRootStat = rootStat;
        inWorkspace = true;
      } else {
        realRoot = undefined;
      }
    } catch {
      realRoot = undefined;
      inWorkspace = false;
    }
  }
  const inWebStorage = isWebStoragePath(realTarget, deps);
  if (!inWorkspace && !inWebStorage) return "missing";

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (inWorkspace && realRoot !== undefined && pinnedRootStat !== undefined) {
      if (
        !(await hasNoSymlinkComponentsFromRoot(realRoot, fsOps)) ||
        !(await hasNoSymlinkComponentsUnderRoot(realTarget, realRoot, fsOps))
      ) {
        return "missing";
      }
    } else if (!(await verifyWebStorageComponents(realTarget, deps, fsOps))) {
      return "missing";
    }

    const preStat = await fsOps.lstat(realTarget);
    if (preStat.isSymbolicLink() || !preStat.isFile()) return "missing";

    handle = await fsOps.open(realTarget, OPEN_READONLY_FLAGS);
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) return "missing";
    if (!sameFileIdentity(openedStat, preStat)) return "missing";

    // Re-verify real path ownership against the pinned root while holding the open file descriptor.
    if (fsOps.platform === "linux") {
      const fdReal = await fsOps.realpath(`/proc/self/fd/${handle.fd}`);
      let fdAllowed = false;
      if (inWorkspace && realRoot !== undefined && pinnedRootStat !== undefined) {
        const currentRootStat = await fsOps.lstat(realRoot);
        fdAllowed =
          !currentRootStat.isSymbolicLink() &&
          currentRootStat.isDirectory() &&
          sameFileIdentity(currentRootStat, pinnedRootStat) &&
          isPathWithinRoot(fdReal, realRoot, fsOps.platform) &&
          (await hasNoSymlinkComponentsFromRoot(fdReal, fsOps));
      } else {
        fdAllowed = await verifyWebStorageComponents(fdReal, deps, fsOps);
      }
      if (!fdAllowed) return "missing";
      const fdPathStat = await fsOps.stat(fdReal);
      if (!sameFileIdentity(fdPathStat, openedStat)) return "missing";
    } else {
      const postReal = await fsOps.realpath(candidate);
      let postAllowed = false;
      if (inWorkspace && workspaceRoot && realRoot !== undefined && pinnedRootStat !== undefined) {
        const postRoot = await fsOps.realpath(workspaceRoot);
        const currentRootStat = await fsOps.lstat(realRoot);
        postAllowed =
          postRoot === realRoot &&
          postReal === realTarget &&
          !currentRootStat.isSymbolicLink() &&
          currentRootStat.isDirectory() &&
          sameFileIdentity(currentRootStat, pinnedRootStat) &&
          isPathWithinRoot(postReal, realRoot, fsOps.platform) &&
          (await hasNoSymlinkComponentsFromRoot(postReal, fsOps));
      } else if (!inWorkspace) {
        postAllowed =
          postReal === realTarget && (await verifyWebStorageComponents(postReal, deps, fsOps));
      }
      if (!postAllowed) return "missing";
      const postStat = await fsOps.stat(postReal);
      if (!sameFileIdentity(postStat, openedStat)) return "missing";
    }

    if (openedStat.size > WEB_IMAGE_LIMITS.maxImageBytes) return "too-large";
    const buffer = Buffer.alloc(openedStat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > WEB_IMAGE_LIMITS.maxImageBytes) return "too-large";
    }
    const after = await handle.stat();
    if (
      length !== openedStat.size ||
      after.size !== openedStat.size ||
      after.mtimeMs !== openedStat.mtimeMs
    ) {
      return "missing";
    }
    return buffer.subarray(0, length);
  } catch {
    return "missing";
  } finally {
    await handle?.close();
  }
}

async function readPromptBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<string | undefined> {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_PROMPT_BODY_BYTES) {
    sendJson(response, 413, { error: "Request body too large" });
    request.resume();
    return undefined;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.byteLength;
    if (total > MAX_PROMPT_BODY_BYTES) {
      sendJson(response, 413, { error: "Request body too large" });
      request.resume();
      return undefined;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function handleUploads(
  request: IncomingMessage,
  response: ServerResponse,
  deps: PeerAttachmentsDeps,
): Promise<void> {
  try {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/octet-stream") {
      sendJson(response, 415, { error: "content type must be application/octet-stream" });
      return;
    }
    const url = new URL(request.url ?? "", "http://localhost");
    const threadId = url.searchParams.get("threadId");
    const scope = url.searchParams.get("scope");
    if ((threadId !== null && scope !== null) || (threadId === null && scope === null)) {
      sendJson(response, 400, { error: "Specify exactly one of threadId or scope" });
      return;
    }
    if (threadId !== null && (threadId.length === 0 || threadId.length > 1024)) {
      sendJson(response, 400, { error: "Invalid threadId" });
      return;
    }
    if (scope !== null && !c.REMOTE_PEER_UPLOAD_SCOPE_PATTERN.test(scope)) {
      sendJson(response, 400, { error: "Invalid upload scope" });
      return;
    }
    const name = url.searchParams.get("name") ?? undefined;
    const imageMediaType = url.searchParams.get("imageMediaType") ?? undefined;
    const chunks = async function* (): AsyncGenerator<Uint8Array> {
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      }
    };
    const value =
      threadId !== null
        ? await deps.sessions.uploadFile(threadId, chunks(), name, imageMediaType)
        : await deps.files.upload(
            `${PEER_UPLOAD_SCOPE_PREFIX}${scope ?? ""}`,
            chunks(),
            name,
            imageMediaType,
          );
    sendJson(response, 200, c.remotePeerUploadResultSchema.parse({ ok: true, value }));
  } catch (error) {
    sendJson(response, 200, errorEnvelope(error, "File upload failed"));
  } finally {
    request.resume();
  }
}

async function handlePrompt(
  request: IncomingMessage,
  response: ServerResponse,
  deps: PeerAttachmentsDeps,
): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    request.resume();
    return;
  }
  const rawBody = await readPromptBody(request, response);
  if (rawBody === undefined) return;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    sendJson(response, 400, { error: "Invalid JSON request body" });
    return;
  }
  const parsed = c.remotePeerPromptParamsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    sendJson(response, 400, { error: "Invalid peer prompt parameters" });
    return;
  }
  const { threadId, scope, requestId, mode, expectedTurnId, content } = parsed.data;
  if (scope !== undefined) {
    deps.files.bind(`${PEER_UPLOAD_SCOPE_PREFIX}${scope}`, threadId);
  }
  const reply = await deps.rpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: threadId,
        ...(requestId !== undefined ? { requestId } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(expectedTurnId !== undefined ? { expectedTurnId } : {}),
        content,
      },
    },
  });
  if (reply.ok) {
    const envelope = c.remotePeerPromptResultSchema.safeParse(reply);
    if (envelope.success) {
      sendJson(response, 200, envelope.data);
      return;
    }
    sendJson(response, 200, {
      ok: false,
      error: { code: "gateway/internal", message: "Unexpected prompt response" },
    });
    return;
  }
  const details = isPlainObject(reply.error.details) ? reply.error.details : undefined;
  sendJson(response, 200, {
    ok: false,
    error: {
      code: reply.error.code,
      message: reply.error.message,
      ...(details !== undefined ? { details } : {}),
    },
  });
}

async function handleFile(
  request: IncomingMessage,
  response: ServerResponse,
  deps: PeerAttachmentsDeps,
): Promise<void> {
  const isHead = request.method === "HEAD";
  if (request.method !== "GET" && !isHead) {
    sendPlain(response, 405, "method not allowed");
    request.resume();
    return;
  }
  const url = new URL(request.url ?? "", "http://localhost");
  const threadId = url.searchParams.get("threadId");
  const rawPath = url.searchParams.get("path");
  if (!threadId || !rawPath) {
    sendPlain(response, 400, "missing parameters", isHead);
    return;
  }
  const workspaceRoot = deps.sessions.localWorkspaceRoot(threadId);
  if (workspaceRoot === undefined) {
    sendPlain(response, 404, "image unavailable", isHead);
    return;
  }
  const normalizedRaw =
    process.platform === "win32" ? rawPath.replace(/^\/(?=[A-Za-z]:[/\\])/u, "") : rawPath;
  if (
    normalizedRaw.startsWith("\\\\") ||
    normalizedRaw.startsWith("//") ||
    /[\u0000-\u001f\u007f]/u.test(normalizedRaw)
  ) {
    sendPlain(response, 404, "image unavailable", isHead);
    return;
  }
  let candidate: string;
  if (isAbsolute(normalizedRaw)) {
    candidate = resolve(normalizedRaw);
  } else {
    if (!workspaceRoot) {
      sendPlain(response, 404, "image unavailable", isHead);
      return;
    }
    candidate = resolve(workspaceRoot, normalizedRaw);
  }
  const bytes = await readVerifiedAttachmentFile(candidate, workspaceRoot, deps);
  if (bytes === "too-large") {
    sendPlain(response, 413, "image too large", isHead);
    return;
  }
  if (bytes === "missing") {
    sendPlain(response, 404, "image unavailable", isHead);
    return;
  }
  let image;
  try {
    image = inspectImage(bytes);
  } catch (error) {
    const reason =
      error instanceof RpcError && "reason" in error.details ? error.details.reason : undefined;
    if (reason === "IMAGE_TOO_LARGE" || reason === "IMAGE_TOO_MANY_PIXELS") {
      sendPlain(response, 413, "image too large", isHead);
      return;
    }
    sendPlain(response, 404, "image unavailable", isHead);
    return;
  }
  response.writeHead(200, {
    "Content-Type": image.ref.mediaType,
    "Content-Length": String(image.bytes.length),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
  });
  response.end(isHead ? undefined : image.bytes);
}

export async function servePeerAttachments(
  request: IncomingMessage,
  response: ServerResponse,
  route: PeerAttachmentsRoute,
  deps: PeerAttachmentsDeps,
): Promise<void> {
  if (route === "uploads") return handleUploads(request, response, deps);
  if (route === "prompt") return handlePrompt(request, response, deps);
  return handleFile(request, response, deps);
}
