/** Raw-byte upload transport, called only after the Web auth and same-origin gates. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChSessions } from "./ch-sessions.ts";
import { RpcError } from "./transport.ts";
import { WEB_FILE_LIMITS } from "./web-files.ts";

export async function serveFileUpload(
  sessions: ChSessions | undefined,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const send = (status: number, body: unknown) =>
    response
      .writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      })
      .end(JSON.stringify(body));
  try {
    if (
      request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/octet-stream"
    ) {
      send(415, { error: "content type must be application/octet-stream" });
      return;
    }
    if (Number(request.headers["content-length"]) > WEB_FILE_LIMITS.maxFileBytes) {
      send(413, { error: "File exceeds 64 MiB." });
      return;
    }
    const url = new URL(request.url ?? "", "http://localhost");
    const id = url.searchParams.get("sessionId");
    if (!id) {
      send(400, { error: "sessionId is required" });
      return;
    }
    if (!sessions)
      throw new RpcError("session/attachment-invalid", "Standalone file uploads are unavailable.");
    const value = await sessions.uploadFile(
      id,
      request.iterator({ destroyOnReturn: false }),
      url.searchParams.get("name") ?? undefined,
    );
    send(200, { ok: true, value });
  } catch (error) {
    send(200, {
      ok: false,
      error: {
        code: error instanceof RpcError ? error.code : "gateway/internal",
        message: error instanceof Error ? error.message : "File upload failed",
        details: error instanceof RpcError ? error.details : {},
      },
    });
  } finally {
    request.resume();
  }
}
