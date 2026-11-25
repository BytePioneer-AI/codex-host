/** B-side HTTP handler for `/api/peer/v1/delegation`, called after auth and same-origin gates. */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as c from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import { compressResponse } from "./compression.ts";
import { RpcError } from "./transport.ts";

const MAX_PEER_DELEGATION_BODY_BYTES = 2 * 1024 * 1024;

export interface PeerDelegationHttpDeps {
  enabled: boolean;
  chHost?: Pick<ChHostClient, "realtime">;
  /** Server-authenticated credential ID from AccessAuth, used to isolate per-Peer dedup scope. */
  credential?: string;
}

async function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: unknown,
): Promise<void> {
  const contentType = "application/json; charset=utf-8";
  const compressed = await compressResponse(
    Buffer.from(JSON.stringify(body)),
    contentType,
    request.headers["accept-encoding"],
  );
  if (response.destroyed || response.writableEnded || response.headersSent) return;
  response
    .writeHead(status, {
      "content-type": contentType,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...compressed.headers,
    })
    .end(compressed.body);
}

async function readDelegationBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<string | undefined> {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_PEER_DELEGATION_BODY_BYTES) {
    await sendJson(request, response, 413, {
      ok: false,
      error: { code: "INVALID_ARGUMENT", message: "Peer delegation request body is too large" },
    });
    request.resume();
    return undefined;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.byteLength;
    if (total > MAX_PEER_DELEGATION_BODY_BYTES) {
      await sendJson(request, response, 413, {
        ok: false,
        error: { code: "INVALID_ARGUMENT", message: "Peer delegation request body is too large" },
      });
      request.resume();
      return undefined;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function errorReply(code: string, message: string): c.PeerDelegationResponse {
  return { ok: false, error: { code, message } };
}

function peerSourceScope(credential: string | undefined, sourceId: string | undefined): string {
  return createHash("sha256")
    .update(`${credential ?? "anonymous"}:${sourceId ?? "default"}`)
    .digest("hex")
    .slice(0, 16);
}

export async function servePeerDelegation(
  request: IncomingMessage,
  response: ServerResponse,
  deps: PeerDelegationHttpDeps,
): Promise<void> {
  if (request.method !== "POST") {
    await sendJson(request, response, 405, errorReply("INVALID_ARGUMENT", "Method not allowed"));
    request.resume();
    return;
  }
  if (
    !deps.enabled ||
    !deps.chHost?.realtime ||
    deps.chHost.realtime.peerDelegationSupported?.() === false
  ) {
    await sendJson(
      request,
      response,
      503,
      errorReply("UNSUPPORTED", "Peer delegation is unavailable on this Host"),
    );
    request.resume();
    return;
  }
  const rawBody = await readDelegationBody(request, response);
  if (rawBody === undefined) return;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    await sendJson(
      request,
      response,
      400,
      errorReply("INVALID_ARGUMENT", "Invalid JSON request body"),
    );
    return;
  }
  const parsed = c.peerDelegationRequestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    await sendJson(
      request,
      response,
      400,
      errorReply("INVALID_ARGUMENT", "Invalid peer delegation request"),
    );
    return;
  }
  const { operation, hopCount, sourceId, input } = parsed.data;
  if (hopCount < 1) {
    await sendJson(
      request,
      response,
      400,
      errorReply("INVALID_ARGUMENT", "Peer delegation hopCount must be at least 1"),
    );
    return;
  }
  if (hopCount > c.PEER_DELEGATION_MAX_HOPS) {
    await sendJson(
      request,
      response,
      403,
      errorReply("FORBIDDEN", "Peer delegation hop limit exceeded (maximum 1 hop)"),
    );
    return;
  }
  if (typeof input.hostId === "string" && input.hostId !== "" && input.hostId !== "local") {
    await sendJson(
      request,
      response,
      403,
      errorReply("FORBIDDEN", "Nested remote delegation is not allowed (hop limit 1)"),
    );
    return;
  }

  try {
    const reply = await deps.chHost.realtime.request(c.PEER_DELEGATION_CHANNEL_METHOD, {
      operation,
      hopCount,
      sourceId: peerSourceScope(deps.credential, sourceId),
      input,
    });
    const validated = c.peerDelegationResponseSchema.safeParse(reply);
    if (!validated.success) {
      await sendJson(
        request,
        response,
        502,
        errorReply("INTERNAL_ERROR", "Host Runtime returned an invalid peer delegation response"),
      );
      return;
    }
    await sendJson(request, response, 200, validated.data);
  } catch (error) {
    console.error("[remote-peers] /api/peer/v1/delegation failed:", error);
    if (error instanceof RpcError) {
      if (error.code === "host/offline") {
        await sendJson(
          request,
          response,
          503,
          errorReply("RUNTIME_UNREACHABLE", "Remote Host Runtime is unavailable"),
        );
        return;
      }
      await sendJson(
        request,
        response,
        200,
        errorReply("DELEGATION_FAILED", "Remote Host Runtime rejected the delegation request"),
      );
      return;
    }
    await sendJson(
      request,
      response,
      500,
      errorReply("INTERNAL_ERROR", "Peer delegation failed on remote Host"),
    );
  }
}
