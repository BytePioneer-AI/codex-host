/** Loopback-only authenticated bridge exposing paired Peer delegation to the local Host Runtime. */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import * as c from "@codexhost/shared-contracts";
import type { PeerHostManager } from "./peer-host-manager.ts";
import { RpcError } from "./transport.ts";

const MAX_BRIDGE_BODY_BYTES = 2 * 1024 * 1024;
const BRIDGE_ROUTE = "/v1/peer/delegation";

export interface PeerDelegationBridge {
  readonly descriptorPath: string;
  readonly descriptor: c.PeerDelegationBridgeDescriptor;
  close(): Promise<void>;
}

export interface PeerDelegationBridgeOptions {
  peerManager: Pick<PeerHostManager, "client" | "delegationHosts"> &
    Partial<Pick<PeerHostManager, "peerTokens">>;
  dataDirectory: string;
  timeoutMs?: number;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded || response.headersSent) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  if ("origin" in request.headers) return false;
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

async function readBridgeBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<string | undefined> {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_BRIDGE_BODY_BYTES) {
    sendJson(response, 413, {
      ok: false,
      error: { code: "INVALID_ARGUMENT", message: "Bridge request body is too large" },
    });
    request.resume();
    return undefined;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.byteLength;
    if (total > MAX_BRIDGE_BODY_BYTES) {
      sendJson(response, 413, {
        ok: false,
        error: { code: "INVALID_ARGUMENT", message: "Bridge request body is too large" },
      });
      request.resume();
      return undefined;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

const BRIDGE_CLIENT_SAFE_MESSAGES: Readonly<Record<string, string>> = {
  INVALID_ARGUMENT: "Invalid peer delegation request",
  HARNESS_NOT_FOUND: "Requested Harness is unavailable on remote Peer",
  THREAD_NOT_FOUND: "Thread was not found on remote Peer",
  THREAD_BUSY: "Thread is busy on remote Peer",
  PARENT_THREAD_AMBIGUOUS: "Remote Peer runtime session is ambiguous",
  RESPONSE_TOO_LARGE: "Response from remote Peer is too large",
  RUNTIME_UNREACHABLE: "Remote Peer runtime is unavailable",
  DELEGATION_FAILED: "Peer delegation operation failed",
  FORBIDDEN: "Peer delegation request is forbidden",
  UNSUPPORTED: "Operation is not supported on remote Peer",
  UNAUTHORIZED: "Peer delegation request is unauthorized",
  CURSOR_EXPIRED: "Cursor expired on remote Peer",
  QUESTION_NOT_PENDING: "Question is no longer pending on remote Peer",
  INTERNAL_ERROR: "Peer delegation operation failed",
};

const SAFE_HARNESS_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SAFE_GIT_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const SAFE_GIT_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const MAX_SAFE_HARNESS_IDS = 32;

function isSafeBranchName(value: unknown): value is string {
  if (typeof value !== "string" || !SAFE_GIT_BRANCH_RE.test(value)) return false;
  if (
    value.includes("..") ||
    value.includes("//") ||
    value.includes("://") ||
    value.includes("@{") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock")
  ) {
    return false;
  }
  return true;
}

function isSafeCommitSha(value: unknown): value is string {
  return typeof value === "string" && SAFE_GIT_SHA_RE.test(value);
}

function isSafeHarnessId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SAFE_HARNESS_ID_RE.test(value) &&
    (value === "codex" || c.harnessIdSchema.safeParse(value).success)
  );
}

function containsPeerSecret(value: string, secrets: readonly string[]): boolean {
  for (const secret of secrets) {
    if (secret.length > 0 && (value === secret || value.includes(secret))) return true;
  }
  return false;
}

function sanitizeRemoteErrorDetails(
  details: Record<string, c.JsonValue> | undefined,
  secrets: readonly string[],
): Record<string, c.JsonValue> | undefined {
  if (!details) return undefined;
  const safe: Record<string, c.JsonValue> = {};
  if (Array.isArray(details.validHarnessIds)) {
    const valid = [
      ...new Set(
        details.validHarnessIds.filter(
          (id): id is string => isSafeHarnessId(id) && !containsPeerSecret(id, secrets),
        ),
      ),
    ].slice(0, MAX_SAFE_HARNESS_IDS);
    if (valid.length > 0) safe.validHarnessIds = valid;
  }
  if (typeof details.readOnly === "boolean") {
    safe.readOnly = details.readOnly;
  }
  if (typeof details.worktreeRetained === "boolean") {
    safe.worktreeRetained = details.worktreeRetained;
  }
  if (
    details.worktree &&
    typeof details.worktree === "object" &&
    !Array.isArray(details.worktree)
  ) {
    const wt = details.worktree as Record<string, unknown>;
    if (
      isSafeBranchName(wt.branch) &&
      isSafeCommitSha(wt.base) &&
      !containsPeerSecret(wt.branch, secrets) &&
      !containsPeerSecret(wt.base, secrets)
    ) {
      safe.worktree = { branch: wt.branch, base: wt.base };
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

/** Independently re-sanitize remote HTTP 200 `{ ok: false, error }` envelopes at the A bridge boundary. */
function sanitizeRemoteDelegationReply(
  reply: c.PeerDelegationResponse,
  secrets: readonly string[],
): c.PeerDelegationResponse {
  if (reply.ok) return reply;
  const safeCode = Object.hasOwn(BRIDGE_CLIENT_SAFE_MESSAGES, reply.error.code)
    ? reply.error.code
    : "DELEGATION_FAILED";
  console.error("[remote-peers] remote peer returned delegation error:", safeCode);
  const safeMessage = BRIDGE_CLIENT_SAFE_MESSAGES[safeCode] ?? "Peer delegation operation failed";
  const safeDetails = sanitizeRemoteErrorDetails(reply.error.details, secrets);
  return {
    ok: false,
    error: {
      code: safeCode,
      message: safeMessage,
      ...(safeDetails ? { details: safeDetails } : {}),
    },
  };
}

function mapPeerError(error: unknown): c.PeerDelegationResponse {
  if (error instanceof RpcError) {
    const status =
      "httpStatus" in error.details && typeof error.details.httpStatus === "number"
        ? error.details.httpStatus
        : undefined;
    if (error.code === "remote/unsupported") {
      return {
        ok: false,
        error: {
          code: "UNSUPPORTED",
          message: "Remote peer does not support cross-host delegation",
        },
      };
    }
    if (error.code === "remote/auth-error") {
      return {
        ok: false,
        error: { code: "UNAUTHORIZED", message: "Remote peer rejected the access token" },
      };
    }
    if (error.code === "remote/offline") {
      return {
        ok: false,
        error: { code: "RUNTIME_UNREACHABLE", message: "Remote peer is offline or unreachable" },
      };
    }
    if (error.code === "remote/request-failed") {
      if (status === 403) {
        return {
          ok: false,
          error: { code: "FORBIDDEN", message: "Remote peer rejected the delegation request" },
        };
      }
      if (status === 400) {
        return {
          ok: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: "Remote peer rejected the delegation parameters",
          },
        };
      }
      if (status === 404 || status === 503) {
        return {
          ok: false,
          error: { code: "UNSUPPORTED", message: "Remote peer delegation endpoint is unavailable" },
        };
      }
      return {
        ok: false,
        error: { code: "RUNTIME_UNREACHABLE", message: "Remote peer delegation request failed" },
      };
    }
    if (error.code === "remote/read-failed") {
      return {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Remote peer returned an invalid delegation reply",
        },
      };
    }
    return {
      ok: false,
      error: { code: "DELEGATION_FAILED", message: "Remote peer delegation failed" },
    };
  }
  console.error("[remote-peers] bridge peer call error:", error);
  return {
    ok: false,
    error: { code: "INTERNAL_ERROR", message: "Peer delegation bridge failed" },
  };
}

export async function startPeerDelegationBridge(
  options: PeerDelegationBridgeOptions,
): Promise<PeerDelegationBridge> {
  const token = randomBytes(32).toString("hex");
  const instanceId = randomUUID();
  const server = createServer((request, response) => {
    void (async () => {
      if (!isAuthorized(request, token)) {
        sendJson(response, 401, {
          ok: false,
          error: { code: "UNAUTHORIZED", message: "Invalid peer delegation bridge token" },
        });
        request.resume();
        return;
      }
      const pathname = (request.url ?? "/").split("?")[0];
      if (request.method !== "POST" || pathname !== BRIDGE_ROUTE) {
        sendJson(response, 404, {
          ok: false,
          error: { code: "INVALID_ARGUMENT", message: "Unknown bridge route" },
        });
        request.resume();
        return;
      }
      const rawBody = await readBridgeBody(request, response);
      if (rawBody === undefined) return;
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawBody);
      } catch {
        sendJson(response, 400, {
          ok: false,
          error: { code: "INVALID_ARGUMENT", message: "Bridge request must be valid JSON" },
        });
        return;
      }
      const parsed = c.peerDelegationBridgeRequestSchema.safeParse(parsedJson);
      if (!parsed.success) {
        sendJson(response, 400, {
          ok: false,
          error: { code: "INVALID_ARGUMENT", message: "Invalid peer delegation bridge request" },
        });
        return;
      }
      const req = parsed.data;
      if (req.operation === "hosts") {
        sendJson(response, 200, {
          ok: true,
          value: { hosts: options.peerManager.delegationHosts() },
        });
        return;
      }
      if (req.hopCount < 1) {
        sendJson(response, 200, {
          ok: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: "Peer delegation hopCount must be at least 1",
          },
        });
        return;
      }
      if (req.hopCount > c.PEER_DELEGATION_MAX_HOPS) {
        sendJson(response, 200, {
          ok: false,
          error: {
            code: "FORBIDDEN",
            message: "Peer delegation hop limit exceeded (maximum 1 hop)",
          },
        });
        return;
      }
      const client = options.peerManager.client(req.hostId);
      if (!client) {
        sendJson(response, 200, {
          ok: false,
          error: { code: "RUNTIME_UNREACHABLE", message: "Unknown remote peer" },
        });
        return;
      }
      const effectiveTimeoutMs =
        req.timeoutMs !== undefined
          ? Math.max(1, Math.min(req.timeoutMs, options.timeoutMs ?? 60_000))
          : options.timeoutMs;
      const callerAbort = new AbortController();
      const onClose = () => {
        if (!response.writableEnded) callerAbort.abort();
      };
      response.once("close", onClose);
      try {
        const reply = await client.delegate(
          { operation: req.operation, hopCount: req.hopCount, input: req.input },
          {
            ...(effectiveTimeoutMs === undefined ? {} : { timeoutMs: effectiveTimeoutMs }),
            signal: callerAbort.signal,
          },
        );
        const secrets = new Set<string>(options.peerManager.peerTokens?.() ?? []);
        if (typeof client.record?.token === "string" && client.record.token.length > 0) {
          secrets.add(client.record.token);
        }
        sendJson(response, 200, sanitizeRemoteDelegationReply(reply, [...secrets]));
      } catch (error) {
        sendJson(response, 200, mapPeerError(error));
      } finally {
        response.off("close", onClose);
      }
    })().catch((error: unknown) => {
      console.error("[remote-peers] bridge request failed:", error);
      sendJson(response, 500, {
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "Peer delegation bridge error" },
      });
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo;
  const descriptor: c.PeerDelegationBridgeDescriptor = {
    version: c.PEER_DELEGATION_BRIDGE_VERSION,
    instanceId,
    pid: process.pid,
    endpoint: `http://127.0.0.1:${address.port}`,
    token,
    startedAt: Date.now(),
  };
  const bridgeDir = join(options.dataDirectory, c.PEER_DELEGATION_BRIDGE_DIR);
  const descriptorPath = join(bridgeDir, `bridge-${process.pid}-${instanceId}.json`);
  const temporary = `${descriptorPath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await mkdir(bridgeDir, { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(descriptor), { flag: "wx", mode: 0o600 });
    await rename(temporary, descriptorPath);
  } catch (error) {
    server.closeAllConnections();
    server.close();
    await rm(temporary, { force: true });
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    descriptorPath,
    descriptor,
    close(): Promise<void> {
      return (closing ??= (async () => {
        const closed = new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
          server.closeAllConnections();
        });
        await rm(descriptorPath, { force: true });
        await closed;
      })());
    },
  };
}
