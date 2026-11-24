/** Peer attachment HTTP endpoints (`/api/peer/v1/uploads|prompt|file`), called after auth and same-origin gates. */
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
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

function isPathWithinRoot(candidate: string, root: string): boolean {
  const normCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const normRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const rel = relative(normRoot, normCandidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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

async function readBoundedRegularFile(
  targetPath: string,
): Promise<Buffer | "too-large" | "missing"> {
  let handle;
  try {
    handle = await open(
      targetPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (!before.isFile()) return "missing";
    if (before.size > WEB_IMAGE_LIMITS.maxImageBytes) return "too-large";
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > WEB_IMAGE_LIMITS.maxImageBytes) return "too-large";
    }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      return "missing";
    }
    return buffer.subarray(0, length);
  } catch {
    return "missing";
  } finally {
    await handle?.close();
  }
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
  let realTarget: string;
  try {
    realTarget = await realpath(candidate);
  } catch {
    sendPlain(response, 404, "image unavailable", isHead);
    return;
  }
  let inWorkspace = false;
  if (workspaceRoot) {
    try {
      const realRoot = await realpath(workspaceRoot);
      inWorkspace = isPathWithinRoot(realTarget, realRoot);
    } catch {
      inWorkspace = false;
    }
  }
  const allowed =
    inWorkspace ||
    deps.files.reference(realTarget) !== undefined ||
    deps.images.idForPath(realTarget) !== undefined;
  if (!allowed) {
    sendPlain(response, 404, "image unavailable", isHead);
    return;
  }
  const bytes = await readBoundedRegularFile(realTarget);
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
