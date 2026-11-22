/** Raw-byte upload transport, called only after the Web auth and same-origin gates. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FileUploadTiming } from "./ch-file-inputs.ts";
import type { ChSessions } from "./ch-sessions.ts";
import { RpcError } from "./transport.ts";

export async function serveFileUpload(
  sessions: Pick<ChSessions, "uploadFile"> | undefined,
  request: IncomingMessage,
  response: ServerResponse,
  viaRelay = false,
): Promise<void> {
  const started = performance.now();
  const timing: FileUploadTiming = {};
  let sessionId: string | undefined;
  let bytes = 0;
  let firstByteMs: number | undefined;
  let bodyEndMs: number | undefined;
  let ok = false;
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
    const url = new URL(request.url ?? "", "http://localhost");
    const id = url.searchParams.get("sessionId");
    if (!id) {
      send(400, { error: "sessionId is required" });
      return;
    }
    if (!sessions)
      throw new RpcError("session/attachment-invalid", "Standalone file uploads are unavailable.");
    sessionId = id;
    const chunks = async function* () {
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        firstByteMs ??= performance.now() - started;
        bytes += (chunk as Buffer).byteLength;
        yield chunk as Buffer;
      }
      bodyEndMs = performance.now() - started;
    };
    const value = await sessions.uploadFile(
      id,
      chunks(),
      url.searchParams.get("name") ?? undefined,
      url.searchParams.get("imageMediaType") ?? undefined,
      timing,
    );
    ok = true;
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
    if (sessionId !== undefined) {
      const rounded = (ms: number | undefined) =>
        ms === undefined ? undefined : Math.round(ms * 100) / 100;
      console.info(
        `[uploadFileBinary] ${JSON.stringify({
          sessionId,
          bytes,
          viaRelay,
          httpVersion: request.httpVersion,
          ok,
          totalMs: rounded(performance.now() - started),
          firstByteMs: rounded(firstByteMs),
          bodyEndMs: rounded(bodyEndMs),
          ...Object.fromEntries(Object.entries(timing).map(([stage, ms]) => [stage, rounded(ms)])),
        })}`,
      );
    }
    request.resume();
  }
}
