/** Hub-side remote peer workspace-file identity resolution, RPC proxy, WS watch degradation, and streaming downloads. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { REMOTE_PEER_HOST_ID_PREFIX } from "@codexhost/shared-contracts";
import type { PeerHostClient } from "./peer-host-client.ts";
import {
  PEER_WORKSPACE_FILE_METHODS,
  PEER_WORKSPACE_FILES_HEADER,
} from "./peer-workspace-files-http.ts";
import { remoteSessionIdentity } from "./remote-sessions.ts";
import type { StreamSink } from "./transport.ts";
import type { WorkspaceDownloadGrant, WorkspaceDownloadTickets } from "./workspace-file-actions.ts";

export type PeerWorkspaceFileEndpoint = Pick<PeerHostClient, "record" | "state" | "manifest">;

export interface RemoteWorkspaceFileSessionResolver {
  resolveDraftCanonicalId(sessionId: string): {
    readonly isDraft: boolean;
    readonly canonicalId?: string;
    readonly hostId?: string;
  };
  peerClient(hostId: string): PeerWorkspaceFileEndpoint | undefined;
}

export interface RemotePeerWorkspaceFilesOptions {
  readonly rpcTimeoutMs?: number;
  readonly officeRenderTimeoutMs?: number;
  readonly downloadHandshakeTimeoutMs?: number;
}

export type ResolvedRemoteWorkspaceTarget =
  | { readonly kind: "local" }
  | {
      readonly kind: "peer";
      readonly peer: PeerWorkspaceFileEndpoint;
      readonly hostId: string;
      readonly threadId: string;
      readonly canonicalId: string;
    }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
      readonly details: Record<string, unknown>;
      readonly httpStatus: number;
    };

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_OFFICE_RENDER_TIMEOUT_MS = 65_000;
const DEFAULT_DOWNLOAD_HANDSHAKE_TIMEOUT_MS = 30_000;
const REMOTE_SESSION_PREFIX = "web-remote:";
const REMOTE_CONTROL_PREFIX = "remote-control:";

const SAFE_PROXY_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
} as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRemoteWorkspaceScopeId(scopeId: unknown): scopeId is string {
  return (
    typeof scopeId === "string" &&
    (scopeId.startsWith(REMOTE_SESSION_PREFIX) || scopeId.startsWith(REMOTE_CONTROL_PREFIX))
  );
}

function isNestedRemoteThreadId(threadId: string): boolean {
  return (
    threadId.startsWith(REMOTE_SESSION_PREFIX) ||
    threadId.startsWith(REMOTE_CONTROL_PREFIX) ||
    threadId.startsWith(REMOTE_PEER_HOST_ID_PREFIX)
  );
}

function encodeContentDisposition(fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/gu,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="download"; filename*=UTF-8''${encoded}`;
}

function fileBaseName(rawPath: string): string {
  const normalized = rawPath.replaceAll("\\", "/").replace(/\/+$/u, "");
  return basename(normalized) || "download";
}

function writeTypertError(
  response: ServerResponse,
  rpcId: string,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
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
    .writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(payload.byteLength),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    })
    .end(payload);
}

function writePlainError(
  response: ServerResponse,
  status: number,
  message: string,
  isHead = false,
): void {
  if (response.destroyed || response.writableEnded || response.headersSent) return;
  response
    .writeHead(status, {
      "Content-Type": "text/plain; charset=utf-8",
      ...SAFE_PROXY_HEADERS,
    })
    .end(isHead ? undefined : message);
}

function isTypertServerResponseEnvelope(value: unknown): value is {
  type: "server-response";
  rpcId: string;
  result: {
    ok: boolean;
    value?: unknown;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
} {
  if (!isPlainObject(value)) return false;
  if (value.type !== "server-response") return false;
  if (!isPlainObject(value.result) || typeof value.result.ok !== "boolean") return false;
  if (value.result.ok === false) {
    const err = value.result.error;
    if (!isPlainObject(err) || typeof err.code !== "string" || typeof err.message !== "string") {
      return false;
    }
  }
  return true;
}

export class RemotePeerWorkspaceFiles {
  private readonly rpcTimeoutMs: number;
  private readonly officeRenderTimeoutMs: number;
  private readonly downloadHandshakeTimeoutMs: number;

  constructor(
    private readonly resolver: RemoteWorkspaceFileSessionResolver,
    options: RemotePeerWorkspaceFilesOptions = {},
  ) {
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.officeRenderTimeoutMs = options.officeRenderTimeoutMs ?? DEFAULT_OFFICE_RENDER_TIMEOUT_MS;
    this.downloadHandshakeTimeoutMs =
      options.downloadHandshakeTimeoutMs ?? DEFAULT_DOWNLOAD_HANDSHAKE_TIMEOUT_MS;
  }

  /**
   * Resolve a session/scope ID to either local handling, an active capable Peer, or a hard rejection.
   * Never falls back to local Hub paths for any remote-prefixed identity and never creates a remote Thread.
   */
  resolveTarget(
    sessionId: unknown,
    options: { requireOfficePreview?: boolean } = {},
  ): ResolvedRemoteWorkspaceTarget {
    if (!isRemoteWorkspaceScopeId(sessionId)) return { kind: "local" };

    if (sessionId.startsWith(REMOTE_CONTROL_PREFIX)) {
      return {
        kind: "error",
        code: "remote/workspace-files-unsupported",
        message: "Workspace file access is only supported for connected codexhost remote peers.",
        details: { reason: "host-unsupported" },
        httpStatus: 403,
      };
    }

    const draft = this.resolver.resolveDraftCanonicalId(sessionId);
    let targetId = sessionId;
    if (draft.isDraft) {
      if (!draft.canonicalId) {
        return {
          kind: "error",
          code: "remote/workspace-files-unsupported",
          message:
            "Send the first message to create the remote thread before accessing workspace files.",
          details: { reason: "unsubmitted-draft" },
          httpStatus: 409,
        };
      }
      targetId = draft.canonicalId;
    } else if (sessionId.startsWith(`${REMOTE_SESSION_PREFIX}draft-`)) {
      return {
        kind: "error",
        code: "remote/identity-invalid",
        message: "Unknown or expired remote draft session.",
        details: {},
        httpStatus: 404,
      };
    }

    let identity: { hostId: string; threadId: string } | undefined;
    try {
      identity = remoteSessionIdentity(targetId);
    } catch {
      identity = undefined;
    }
    if (!identity || isNestedRemoteThreadId(identity.threadId)) {
      return {
        kind: "error",
        code: "remote/identity-invalid",
        message: "Invalid remote thread identity.",
        details: {},
        httpStatus: 400,
      };
    }

    if (!identity.hostId.startsWith(REMOTE_PEER_HOST_ID_PREFIX)) {
      return {
        kind: "error",
        code: "remote/workspace-files-unsupported",
        message: "Workspace file access is only supported for connected codexhost remote peers.",
        details: { reason: "host-unsupported" },
        httpStatus: 403,
      };
    }

    const peer = this.resolver.peerClient(identity.hostId);
    if (!peer) {
      return {
        kind: "error",
        code: "remote/offline",
        message: "Remote peer is unavailable or has been removed.",
        details: {},
        httpStatus: 503,
      };
    }
    if (!peer.record.enabled || peer.state === "disabled") {
      return {
        kind: "error",
        code: "remote/offline",
        message: "Remote peer is disabled.",
        details: {},
        httpStatus: 503,
      };
    }
    if (peer.state !== "connected") {
      return {
        kind: "error",
        code: "remote/offline",
        message: "Remote peer is offline. Reconnect and try again.",
        details: {},
        httpStatus: 503,
      };
    }
    if (peer.manifest?.capabilities?.workspaceFiles !== 1) {
      return {
        kind: "error",
        code: "remote/workspace-files-unsupported",
        message:
          "Remote host is running an older version without workspace file preview. Please upgrade codexhost on the remote host.",
        details: { reason: "upgrade-required" },
        httpStatus: 501,
      };
    }
    if (options.requireOfficePreview && peer.manifest?.capabilities?.officePreview !== 1) {
      return {
        kind: "error",
        code: "remote/office-preview-unsupported",
        message:
          "Remote host does not support Office document preview. Please upgrade codexhost on the remote host.",
        details: { reason: "upgrade-required" },
        httpStatus: 501,
      };
    }

    return {
      kind: "peer",
      peer,
      hostId: identity.hostId,
      threadId: identity.threadId,
      canonicalId: targetId,
    };
  }

  /**
   * Intercept `workspaceFiles/changes` streams for remote sessions and fail cleanly with
   * `workspace-file/watch-unsupported` so clients degrade to static stat / manual refresh.
   */
  handleStream(endpoint: string, args: Record<string, unknown>, sink: StreamSink): boolean {
    if (endpoint !== "workspaceFiles/changes") return false;
    if (!isRemoteWorkspaceScopeId(args.workspaceFileScopeId)) return false;
    sink.fail(
      "workspace-file/watch-unsupported",
      "Live workspace file watching is not supported for remote sessions.",
      { path: typeof args.path === "string" ? args.path : "" },
    );
    return true;
  }

  /**
   * Intercept unary DSH workspace-file and Office preview RPCs before Hub's local DSH backend.
   * Returns false for local sessions or non-file methods so existing local paths stay unchanged.
   */
  async handleApiRequest(
    request: IncomingMessage,
    body: string,
    response: ServerResponse,
  ): Promise<boolean> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return false;
    }
    if (!isPlainObject(parsed)) return false;
    const method = parsed.method;
    if (typeof method !== "string" || !PEER_WORKSPACE_FILE_METHODS.has(method)) return false;
    const payload = isPlainObject(parsed.payload) ? parsed.payload : undefined;
    const args = payload && isPlainObject(payload.args) ? payload.args : undefined;
    const scopeId = args?.workspaceFileScopeId;
    if (!isRemoteWorkspaceScopeId(scopeId)) return false;

    const rpcId =
      typeof parsed.rpcId === "string" && parsed.rpcId.length > 0
        ? parsed.rpcId
        : "invalid-request";
    const resolved = this.resolveTarget(scopeId, {
      requireOfficePreview: method === "officeToPdf/render",
    });
    if (resolved.kind === "local") return false;
    if (resolved.kind === "error") {
      writeTypertError(response, rpcId, resolved.code, resolved.message, resolved.details);
      return true;
    }

    const rewrittenBody = JSON.stringify({
      ...parsed,
      rpcId,
      method,
      payload: {
        ...payload,
        args: {
          ...args,
          workspaceFileScopeId: resolved.threadId,
        },
      },
    });

    const timeoutMs =
      method === "officeToPdf/render" ? this.officeRenderTimeoutMs : this.rpcTimeoutMs;
    const browserAbort = new AbortController();
    const timeoutController = new AbortController();
    const timer = setTimeout(
      () => timeoutController.abort(new Error("Peer request timed out")),
      timeoutMs,
    );
    const onClose = (): void => {
      if (!response.writableEnded) browserAbort.abort(new Error("Browser request closed"));
    };
    response.once("close", onClose);
    request.once("aborted", onClose);
    const signal = AbortSignal.any([browserAbort.signal, timeoutController.signal]);

    try {
      const upstream = await fetch(
        `${resolved.peer.record.origin}/api/peer/v1/workspace-files/rpc`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${resolved.peer.record.token}`,
            "content-type": "application/json",
          },
          body: rewrittenBody,
          signal,
        },
      );

      if (browserAbort.signal.aborted || response.destroyed) {
        await upstream.body?.cancel().catch(() => undefined);
        return true;
      }

      const contentType = upstream.headers.get("content-type") ?? "";
      const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";

      if (upstream.status === 401) {
        await upstream.body?.cancel().catch(() => undefined);
        writeTypertError(
          response,
          rpcId,
          "remote/auth-error",
          "Remote peer rejected the access token.",
        );
        return true;
      }

      if (upstream.status === 404 && upstream.headers.get(PEER_WORKSPACE_FILES_HEADER) !== "1") {
        await upstream.body?.cancel().catch(() => undefined);
        writeTypertError(
          response,
          rpcId,
          "remote/workspace-files-unsupported",
          "Remote host is running an older version without workspace file preview. Please upgrade codexhost on the remote host.",
          { reason: "upgrade-required" },
        );
        return true;
      }

      if (upstream.ok && mediaType === "multipart/form-data") {
        const headers: Record<string, string> = {
          "content-type": contentType,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        };
        const contentLength = upstream.headers.get("content-length");
        if (contentLength) headers["content-length"] = contentLength;
        response.writeHead(200, headers);
        if (upstream.body === null) {
          response.end();
        } else {
          await pipeline(
            Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>),
            response,
          );
        }
        return true;
      }

      if (mediaType === "application/json") {
        const text = await upstream.text();
        if (browserAbort.signal.aborted || response.destroyed) return true;
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        if (isTypertServerResponseEnvelope(json)) {
          const restored = Buffer.from(JSON.stringify({ ...json, rpcId }));
          response
            .writeHead(200, {
              "content-type": "application/json; charset=utf-8",
              "content-length": String(restored.byteLength),
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
            })
            .end(restored);
          return true;
        }
        const message =
          isPlainObject(json) && typeof json.error === "string"
            ? json.error
            : `Remote peer returned HTTP ${upstream.status}`;
        writeTypertError(
          response,
          rpcId,
          upstream.status === 403 ? "remote/auth-error" : "remote/request-failed",
          message,
          { httpStatus: upstream.status },
        );
        return true;
      }

      await upstream.body?.cancel().catch(() => undefined);
      writeTypertError(
        response,
        rpcId,
        "remote/request-failed",
        `Remote peer returned HTTP ${upstream.status}`,
        { httpStatus: upstream.status },
      );
      return true;
    } catch (error) {
      if (browserAbort.signal.aborted || response.destroyed || response.writableEnded) return true;
      if (timeoutController.signal.aborted) {
        writeTypertError(
          response,
          rpcId,
          "remote/timeout",
          method === "officeToPdf/render"
            ? "Remote Office document preview timed out."
            : "Remote workspace file request timed out.",
        );
        return true;
      }
      if (!response.headersSent) {
        writeTypertError(
          response,
          rpcId,
          "remote/offline",
          error instanceof Error
            ? `Remote peer is unreachable: ${error.message}`
            : "Remote peer is unreachable.",
        );
      } else {
        response.destroy();
      }
      return true;
    } finally {
      clearTimeout(timer);
      response.off("close", onClose);
      request.off("aborted", onClose);
    }
  }

  /**
   * Issue a download ticket for a remote session file after verifying it on the Peer via HEAD.
   * Returns false when `sessionId` is local so local ticket issuance runs unchanged.
   */
  async issueDownloadTicket(
    response: ServerResponse,
    sessionId: string,
    path: string,
    tickets: WorkspaceDownloadTickets,
    owner?: string,
  ): Promise<boolean> {
    if (!isRemoteWorkspaceScopeId(sessionId)) return false;

    const resolved = this.resolveTarget(sessionId);
    if (resolved.kind === "local") return false;
    if (resolved.kind === "error") {
      writePlainError(response, resolved.httpStatus, resolved.message);
      return true;
    }
    if (!path || /[\u0000-\u001f\u007f]/u.test(path)) {
      writePlainError(response, 400, "invalid path");
      return true;
    }

    const query = new URLSearchParams({ threadId: resolved.threadId, path });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.downloadHandshakeTimeoutMs);
    try {
      const upstream = await fetch(
        `${resolved.peer.record.origin}/api/peer/v1/workspace-files/download?${query.toString()}`,
        {
          method: "HEAD",
          redirect: "error",
          headers: { authorization: `Bearer ${resolved.peer.record.token}` },
          signal: controller.signal,
        },
      );
      if (upstream.status === 404 && upstream.headers.get(PEER_WORKSPACE_FILES_HEADER) !== "1") {
        writePlainError(response, 501, "remote peer upgrade required");
        return true;
      }
      if (!upstream.ok) {
        const status =
          upstream.status === 400 || upstream.status === 403 || upstream.status === 404
            ? upstream.status
            : upstream.status === 401
              ? 502
              : 502;
        writePlainError(response, status, "file unavailable");
        return true;
      }
      const rawLength = upstream.headers.get("content-length");
      const size = rawLength !== null ? Number(rawLength) : 0;
      const ticket = tickets.issue({
        sessionId,
        path,
        ...(owner !== undefined ? { owner } : {}),
      });
      response
        .writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        })
        .end(
          JSON.stringify({
            ticket,
            name: fileBaseName(path),
            size: Number.isFinite(size) && size >= 0 ? size : 0,
          }),
        );
      return true;
    } catch {
      writePlainError(response, 502, "remote peer unavailable");
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stream an original remote workspace file over GET or HEAD (both direct query and ticket grant).
   * Returns false when `sessionId` is local so local file downloads run unchanged.
   */
  async downloadFile(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    grant?: WorkspaceDownloadGrant,
  ): Promise<boolean> {
    const sessionId = grant ? grant.sessionId : (url.searchParams.get("sessionId") ?? "");
    if (!isRemoteWorkspaceScopeId(sessionId)) return false;

    const isHead = request.method === "HEAD";
    const path = grant ? grant.path : (url.searchParams.get("path") ?? "");
    const resolved = this.resolveTarget(sessionId);
    if (resolved.kind === "local") return false;
    if (resolved.kind === "error") {
      writePlainError(response, resolved.httpStatus, resolved.message, isHead);
      return true;
    }
    if (!path || /[\u0000-\u001f\u007f]/u.test(path)) {
      writePlainError(response, 400, "invalid path", isHead);
      return true;
    }

    const browserAbort = new AbortController();
    const handshakeAbort = new AbortController();
    const timer = setTimeout(() => handshakeAbort.abort(), this.downloadHandshakeTimeoutMs);
    const onClose = (): void => {
      if (!response.writableEnded) browserAbort.abort(new Error("Download connection closed"));
    };
    response.once("close", onClose);
    request.once("aborted", onClose);
    const signal = AbortSignal.any([browserAbort.signal, handshakeAbort.signal]);

    const query = new URLSearchParams({ threadId: resolved.threadId, path });
    try {
      const upstream = await fetch(
        `${resolved.peer.record.origin}/api/peer/v1/workspace-files/download?${query.toString()}`,
        {
          method: isHead ? "HEAD" : "GET",
          redirect: "error",
          headers: { authorization: `Bearer ${resolved.peer.record.token}` },
          signal,
        },
      );
      // Handshake succeeded; clear handshake timer so large streaming downloads are never cut off.
      clearTimeout(timer);

      if (browserAbort.signal.aborted || response.destroyed) {
        await upstream.body?.cancel().catch(() => undefined);
        return true;
      }

      if (upstream.status === 404 && upstream.headers.get(PEER_WORKSPACE_FILES_HEADER) !== "1") {
        await upstream.body?.cancel().catch(() => undefined);
        writePlainError(response, 501, "remote peer upgrade required", isHead);
        return true;
      }
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => undefined);
        const status =
          upstream.status === 400 || upstream.status === 403 || upstream.status === 404
            ? upstream.status
            : 502;
        writePlainError(
          response,
          status,
          status === 403 ? "outside workspace" : "file unavailable",
          isHead,
        );
        return true;
      }

      const rawLength = upstream.headers.get("content-length");
      const parsedLength = rawLength !== null ? Number(rawLength) : undefined;
      const headers: Record<string, string> = {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": encodeContentDisposition(fileBaseName(path)),
        ...(parsedLength !== undefined && Number.isSafeInteger(parsedLength) && parsedLength >= 0
          ? { "Content-Length": String(parsedLength) }
          : {}),
        ...SAFE_PROXY_HEADERS,
      };
      response.writeHead(200, headers);
      if (isHead || upstream.body === null) {
        response.end();
        return true;
      }
      await pipeline(Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>), response);
      return true;
    } catch {
      if (browserAbort.signal.aborted || response.destroyed || response.writableEnded) return true;
      if (!response.headersSent) {
        writePlainError(response, 502, "remote peer unavailable", isHead);
      } else {
        response.destroy();
      }
      return true;
    } finally {
      clearTimeout(timer);
      response.off("close", onClose);
      request.off("aborted", onClose);
    }
  }
}
