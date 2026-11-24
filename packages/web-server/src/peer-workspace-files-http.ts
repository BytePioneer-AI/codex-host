/** Peer workspace-file HTTP endpoints (`/api/peer/v1/workspace-files/rpc|download|search`), called after auth and same-origin gates. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, posix, win32 } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { REMOTE_PEER_HOST_ID_PREFIX } from "@codexhost/shared-contracts";
import {
  OfficeToPdfError,
  type OfficeExtension,
  type OfficeToPdfPriority,
  type OfficeToPdfRequest,
  type OfficeToPdfResult,
} from "./dsh-web-services.ts";
import {
  listConfinedWorkspaceDirectory,
  openConfinedWorkspaceFile,
  readConfinedWorkspaceBytes,
  readConfinedWorkspaceText,
  readHandleExactRange,
  statConfinedWorkspaceFile,
  validatePeerWorkspacePath,
  type PeerWorkspaceFsOps,
} from "./peer-confined-fs.ts";
import { WorkspaceFileSearchCache } from "./workspace-file-search.ts";

export { validatePeerWorkspacePath, type PeerWorkspaceFsOps } from "./peer-confined-fs.ts";

export const PEER_WORKSPACE_FILES_HEADER = "x-codexhost-peer-workspace-files";
export const MAX_PEER_SEARCH_QUERY_LENGTH = 512;

export const PEER_WORKSPACE_FILE_METHODS = new Set<string>([
  "workspaceFiles/read",
  "workspaceFiles/readBytes",
  "workspaceFiles/stat",
  "workspaceFiles/list",
  "officeToPdf/render",
]);

export type PeerWorkspaceFilesRoute = "rpc" | "download" | "search";

export interface PeerWorkspaceFilesDsh {
  convertOffice(request: OfficeToPdfRequest, signal: AbortSignal): Promise<OfficeToPdfResult>;
}

export interface PeerWorkspaceFilesDeps {
  resolveWorkspaceRoot(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> | string | undefined;
  dsh?: PeerWorkspaceFilesDsh;
  fsOps?: PeerWorkspaceFsOps;
  searchCache?: WorkspaceFileSearchCache;
}

const defaultPeerSearchCache = new WorkspaceFileSearchCache();
const MAX_RPC_BODY_BYTES = 1024 * 1024;
const MAX_OFFICE_INPUT_BYTES = 50 * 1024 * 1024;
const OFFICE_EXTENSIONS = new Set<string>(["doc", "docx", "xls", "xlsx", "ppt", "pptx"]);

const SAFE_DOWNLOAD_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
  [PEER_WORKSPACE_FILES_HEADER]: "1",
} as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeContentDisposition(fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/gu,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="download"; filename*=UTF-8''${encoded}`;
}

function sendTypertJson(response: ServerResponse, body: unknown, status = 200): void {
  if (response.destroyed || response.writableEnded || response.headersSent) return;
  const payload = Buffer.from(JSON.stringify(body));
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

function sendTypertSuccess(response: ServerResponse, rpcId: string, value: unknown): void {
  sendTypertJson(response, {
    type: "server-response",
    rpcId,
    result: { ok: true, value },
  });
}

function sendTypertError(
  response: ServerResponse,
  rpcId: string,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  status = 200,
): void {
  sendTypertJson(
    response,
    {
      type: "server-response",
      rpcId,
      result: { ok: false, error: { code, message, details } },
    },
    status,
  );
}

async function sendTypertMultipart(
  response: ServerResponse,
  rpcId: string,
  value: Record<string, unknown>,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || response.destroyed || response.writableEnded || response.headersSent)
    return;
  const form = new FormData();
  form.set("bytes-0", new Blob([new Uint8Array(bytes)]));
  form.set(
    "metadata",
    JSON.stringify({
      type: "server-response",
      rpcId,
      result: { ok: true, value },
      attachments: [{ path: ["data"], codec: "bytes", part: "bytes-0" }],
    }),
  );
  const encoded = new Response(form);
  const contentType = encoded.headers.get("content-type");
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    [PEER_WORKSPACE_FILES_HEADER]: "1",
    ...(contentType ? { "content-type": contentType } : {}),
  };
  response.writeHead(200, headers);
  if (encoded.body === null) {
    response.end();
    return;
  }
  await pipeline(Readable.fromWeb(encoded.body as WebReadableStream<Uint8Array>), response);
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
  signal: AbortSignal,
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
    if (signal.aborted) return undefined;
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

function isOfficeErrorCode(error: unknown): error is { code: string; message: string } {
  return (
    error instanceof OfficeToPdfError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "OfficeToPdfError" &&
      "code" in error &&
      typeof error.code === "string")
  );
}

async function handleOfficeRender(
  response: ServerResponse,
  rpcId: string,
  threadId: string,
  workspaceRoot: string,
  args: Record<string, unknown>,
  deps: PeerWorkspaceFilesDeps,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || response.destroyed) return;
  if (!deps.dsh) {
    sendTypertError(
      response,
      rpcId,
      "gateway/service-unavailable",
      "Office conversion service is unavailable on this peer.",
    );
    return;
  }
  const rawPath = args.path;
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    sendTypertError(response, rpcId, "gateway/bad-request", "path is required");
    return;
  }
  const extension = extname(rawPath).slice(1).toLowerCase();
  if (!OFFICE_EXTENSIONS.has(extension)) {
    sendTypertError(response, rpcId, "document-render/failed", "Office conversion failed.", {
      reason: "unsupported-format",
    });
    return;
  }
  const priority: OfficeToPdfPriority =
    args.priority === "background" ? "background" : "foreground";

  // Pre-verify and stat through the confined fd layer before entering Office conversion.
  const opened = await openConfinedWorkspaceFile({
    workspaceRoot,
    path: rawPath,
    ...(deps.fsOps ? { fsOps: deps.fsOps } : {}),
    signal,
  });
  if (signal.aborted || response.destroyed) {
    if (opened.ok) await opened.file.handle.close();
    return;
  }
  if (!opened.ok) {
    sendTypertError(response, rpcId, opened.code, opened.message, opened.details);
    return;
  }
  const sourceAbsolutePath = opened.file.realPath;
  const sourceVersion = opened.file.version;
  const sourceBytes = opened.file.size;
  await opened.file.handle.close();

  if (signal.aborted || response.destroyed) return;
  if (sourceBytes > MAX_OFFICE_INPUT_BYTES) {
    sendTypertError(response, rpcId, "document-render/failed", "Office conversion failed.", {
      reason: "input-too-large",
    });
    return;
  }

  try {
    const converted = await deps.dsh.convertOffice(
      {
        extension: extension as OfficeExtension,
        priority,
        source: {
          key: JSON.stringify([
            threadId,
            workspaceRoot,
            sourceAbsolutePath,
          ]) as OfficeToPdfRequest["source"]["key"],
          version: sourceVersion,
          bytes: sourceBytes,
          read: async (upstream, maxBytes) => {
            upstream.throwIfAborted();
            const cap = Math.min(maxBytes, MAX_OFFICE_INPUT_BYTES);
            const reread = await openConfinedWorkspaceFile({
              workspaceRoot,
              path: rawPath,
              ...(deps.fsOps ? { fsOps: deps.fsOps } : {}),
              signal: upstream,
            });
            if (!reread.ok) {
              if (reread.code === "gateway/cancelled") {
                throw new Error("Office preview cancelled");
              }
              if (reread.code === "workspace-file/outside-workspace") {
                throw Object.assign(new Error(reread.message), {
                  peerWorkspaceError: reread,
                });
              }
              throw new OfficeToPdfError("source-changed", "The source changed.");
            }
            try {
              if (
                reread.file.realPath !== sourceAbsolutePath ||
                reread.file.version !== sourceVersion
              ) {
                throw new OfficeToPdfError("source-changed", "The source changed.");
              }
              if (reread.file.size > cap) {
                throw new OfficeToPdfError(
                  "input-too-large",
                  "The source exceeds the reserved byte capacity.",
                );
              }
              const payload = await readHandleExactRange(reread.file.handle, 0, cap, {
                rejectOnOverflow: true,
                signal: upstream,
              });
              if (payload.overflowed) {
                throw new OfficeToPdfError(
                  "input-too-large",
                  "The source exceeds the reserved byte capacity.",
                );
              }
              return { bytes: payload.bytes, version: reread.file.version };
            } finally {
              await reread.file.handle.close();
            }
          },
        },
      },
      signal,
    );

    if (signal.aborted || response.destroyed) return;
    await sendTypertMultipart(
      response,
      rpcId,
      {
        absolutePath: sourceAbsolutePath,
        version: sourceVersion,
        offset: 0,
        eof: true,
        bytes: converted.pdf.byteLength,
        missingFonts: converted.missingFonts,
        generation: converted.generation,
      },
      converted.pdf,
      signal,
    );
  } catch (error) {
    if (signal.aborted || response.destroyed || response.writableEnded) return;
    if (
      typeof error === "object" &&
      error !== null &&
      "peerWorkspaceError" in error &&
      isPlainObject(error.peerWorkspaceError)
    ) {
      const peerErr = error.peerWorkspaceError as {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
      sendTypertError(response, rpcId, peerErr.code, peerErr.message, peerErr.details ?? {});
      return;
    }
    if (isOfficeErrorCode(error)) {
      sendTypertError(response, rpcId, "document-render/failed", "Office conversion failed.", {
        reason: error.code,
      });
      return;
    }
    sendTypertError(
      response,
      rpcId,
      "gateway/internal",
      error instanceof Error ? error.message : "Office conversion failed.",
    );
  }
}

async function handleRpc(
  request: IncomingMessage,
  response: ServerResponse,
  deps: PeerWorkspaceFilesDeps,
  signal: AbortSignal,
): Promise<void> {
  if (request.method !== "POST") {
    sendPlain(response, 405, "method not allowed");
    request.resume();
    return;
  }
  const rawBody = await readBoundedRpcBody(request, response, signal);
  if (rawBody === undefined || signal.aborted || response.destroyed) return;

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

  const payload = isPlainObject(parsed.payload) ? parsed.payload : undefined;
  const args = payload && isPlainObject(payload.args) ? payload.args : undefined;
  const threadId =
    args && typeof args.workspaceFileScopeId === "string" ? args.workspaceFileScopeId : "";
  if (!threadId || threadId.length > 1024) {
    sendTypertError(response, rpcId, "gateway/bad-request", "workspaceFileScopeId is required");
    return;
  }

  const workspaceRoot = await deps.resolveWorkspaceRoot(threadId, signal);
  if (signal.aborted || response.destroyed) return;
  if (!workspaceRoot) {
    sendTypertError(
      response,
      rpcId,
      "gateway/lookup-not-found",
      "Remote thread workspace is unavailable",
    );
    return;
  }

  if (method === "officeToPdf/render") {
    await handleOfficeRender(response, rpcId, threadId, workspaceRoot, args ?? {}, deps, signal);
    return;
  }

  if (method === "workspaceFiles/stat") {
    const result = await statConfinedWorkspaceFile({
      workspaceRoot,
      path: args?.path,
      ...(deps.fsOps ? { fsOps: deps.fsOps } : {}),
      signal,
    });
    if (signal.aborted || response.destroyed) return;
    if (!result.ok) {
      sendTypertError(response, rpcId, result.code, result.message, result.details);
      return;
    }
    sendTypertSuccess(response, rpcId, result.value);
    return;
  }

  if (method === "workspaceFiles/read") {
    const range = isPlainObject(args?.range) ? args.range : undefined;
    const result = await readConfinedWorkspaceText({
      workspaceRoot,
      path: args?.path,
      ...(range ? { range } : {}),
      ...(deps.fsOps ? { fsOps: deps.fsOps } : {}),
      signal,
    });
    if (signal.aborted || response.destroyed) return;
    if (!result.ok) {
      sendTypertError(response, rpcId, result.code, result.message, result.details);
      return;
    }
    sendTypertSuccess(response, rpcId, result.value);
    return;
  }

  if (method === "workspaceFiles/readBytes") {
    const options = isPlainObject(args?.options) ? args.options : undefined;
    const result = await readConfinedWorkspaceBytes({
      workspaceRoot,
      path: args?.path,
      ...(options ? { options } : {}),
      ...(deps.fsOps ? { fsOps: deps.fsOps } : {}),
      signal,
    });
    if (signal.aborted || response.destroyed) return;
    if (!result.ok) {
      sendTypertError(response, rpcId, result.code, result.message, result.details);
      return;
    }
    const { data, ...rest } = result.value;
    await sendTypertMultipart(response, rpcId, rest, data, signal);
    return;
  }

  if (method === "workspaceFiles/list") {
    const result = await listConfinedWorkspaceDirectory({
      workspaceRoot,
      path: args?.path,
      ...(deps.fsOps ? { fsOps: deps.fsOps } : {}),
      signal,
    });
    if (signal.aborted || response.destroyed) return;
    if (!result.ok) {
      sendTypertError(response, rpcId, result.code, result.message, result.details);
      return;
    }
    sendTypertSuccess(response, rpcId, result.value);
  }
}

async function handleDownload(
  request: IncomingMessage,
  response: ServerResponse,
  deps: PeerWorkspaceFilesDeps,
  signal: AbortSignal,
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
  const workspaceRoot = await deps.resolveWorkspaceRoot(threadId, signal);
  if (signal.aborted || response.destroyed) return;
  if (!workspaceRoot) {
    sendPlain(response, 404, "file unavailable", isHead);
    return;
  }

  const opened = await openConfinedWorkspaceFile({
    workspaceRoot,
    path: rawPath,
    ...(deps.fsOps ? { fsOps: deps.fsOps } : {}),
    signal,
  });
  if (signal.aborted || response.destroyed) {
    if (opened.ok) await opened.file.handle.close();
    return;
  }
  if (!opened.ok) {
    const status =
      opened.code === "workspace-file/outside-workspace"
        ? 403
        : opened.code === "gateway/bad-request"
          ? 400
          : 404;
    sendPlain(
      response,
      status,
      opened.code === "workspace-file/outside-workspace" ? "outside workspace" : "file unavailable",
      isHead,
    );
    return;
  }

  const pathOps = (deps.fsOps?.platform ?? process.platform) === "win32" ? win32 : posix;
  try {
    const fileName = pathOps.basename(opened.file.realPath) || "download";
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": encodeContentDisposition(fileName),
      "Content-Length": String(opened.file.size),
      ...SAFE_DOWNLOAD_HEADERS,
    });
    if (isHead || opened.file.size === 0) {
      response.end();
      return;
    }
    await pipeline(
      opened.file.handle.createReadStream({
        autoClose: false,
        end: Math.max(0, opened.file.size - 1),
      }),
      response,
    );
  } catch {
    if (!response.headersSent && !response.destroyed && !response.writableEnded) {
      sendPlain(response, 404, "file unavailable", isHead);
    } else if (!response.destroyed) {
      response.destroy();
    }
  } finally {
    await opened.file.handle.close();
  }
}

function isNestedRemoteThreadId(threadId: string): boolean {
  return (
    threadId.startsWith("web-remote:") ||
    threadId.startsWith("remote-control:") ||
    threadId.startsWith(REMOTE_PEER_HOST_ID_PREFIX)
  );
}

async function handleSearch(
  request: IncomingMessage,
  response: ServerResponse,
  deps: PeerWorkspaceFilesDeps,
  signal: AbortSignal,
): Promise<void> {
  if (request.method !== "GET") {
    sendPlain(response, 405, "method not allowed");
    request.resume();
    return;
  }
  const url = new URL(request.url ?? "/", "http://localhost");
  const threadId = url.searchParams.get("threadId");
  const query = url.searchParams.get("q") ?? "";

  if (
    !threadId ||
    threadId.length > 1024 ||
    /[\u0000-\u001f\u007f]/u.test(threadId) ||
    isNestedRemoteThreadId(threadId)
  ) {
    sendTypertJson(response, { error: "Invalid threadId", code: "gateway/bad-request" }, 400);
    return;
  }
  if (query.length > MAX_PEER_SEARCH_QUERY_LENGTH || /[\u0000-\u001f\u007f]/u.test(query)) {
    sendTypertJson(response, { error: "Invalid search query", code: "gateway/bad-request" }, 400);
    return;
  }

  let workspaceRoot: string | undefined;
  try {
    workspaceRoot = await deps.resolveWorkspaceRoot(threadId, signal);
  } catch {
    if (signal.aborted || response.destroyed) return;
    workspaceRoot = undefined;
  }
  if (signal.aborted || response.destroyed) return;
  if (!workspaceRoot) {
    sendTypertJson(
      response,
      { error: "Remote thread workspace is unavailable", code: "gateway/lookup-not-found" },
      404,
    );
    return;
  }

  const validated = await validatePeerWorkspacePath({
    workspaceRoot,
    path: ".",
    kind: "directory",
    ...(deps.fsOps ? { fsOps: deps.fsOps } : {}),
    signal,
  });
  if (signal.aborted || response.destroyed) return;
  if (!validated.ok) {
    if (validated.code === "gateway/cancelled") return;
    sendTypertJson(
      response,
      { error: "Remote thread workspace is unavailable", code: "gateway/lookup-not-found" },
      404,
    );
    return;
  }

  const cache = deps.searchCache ?? defaultPeerSearchCache;
  try {
    const items = await cache.list(validated.realRoot, query, signal);
    if (signal.aborted || response.destroyed) return;
    sendTypertJson(response, { items }, 200);
  } catch {
    if (signal.aborted || response.destroyed || response.writableEnded) return;
    sendTypertJson(
      response,
      { error: "Workspace file search failed", code: "gateway/internal" },
      500,
    );
  }
}

export async function servePeerWorkspaceFiles(
  request: IncomingMessage,
  response: ServerResponse,
  route: PeerWorkspaceFilesRoute,
  deps: PeerWorkspaceFilesDeps,
): Promise<void> {
  const lifetime = new AbortController();
  const abort = (): void => {
    if (!response.writableEnded) lifetime.abort(new Error("Peer request connection closed"));
  };
  const onRequestClose = (): void => {
    if (!request.complete) abort();
  };
  response.once("close", abort);
  request.once("aborted", abort);
  request.once("close", onRequestClose);
  try {
    if (route === "rpc") {
      await handleRpc(request, response, deps, lifetime.signal);
    } else if (route === "search") {
      await handleSearch(request, response, deps, lifetime.signal);
    } else {
      await handleDownload(request, response, deps, lifetime.signal);
    }
  } finally {
    response.off("close", abort);
    request.off("aborted", abort);
    request.off("close", onRequestClose);
  }
}
