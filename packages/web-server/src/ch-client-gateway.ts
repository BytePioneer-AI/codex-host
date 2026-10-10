import type { IncomingMessage, ServerResponse } from "node:http";
import {
  clientChannelCursorSchema,
  clientChannelResponseSchema,
} from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";

/** Generic App protocol behind the Web server's auth + same-origin gate. Never
 * exposes the private loopback descriptor/token or creates an execution owner. */
export async function serveChClientGateway(
  host: ChHostClient | undefined,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const reply = (status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  };
  const channel = host?.realtime;
  if (!channel) {
    reply(503, {
      error: {
        code: -32090,
        message: "This Host does not provide client channel v1; update CH to enable it",
      },
    });
    return;
  }
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    const route = url.pathname.slice("/api/ch".length);
    if (request.method === "GET" && route === "/v1/events") {
      const after = url.searchParams.has("epoch")
        ? clientChannelCursorSchema.parse({
            epoch: url.searchParams.get("epoch"),
            sequence: Number(url.searchParams.get("after")),
          })
        : undefined;
      const stop = channel.subscribe((event) => {
        if (event.type === "connection") {
          if (!event.online && !response.writableEnded && !response.destroyed) {
            if (!response.headersSent)
              reply(503, { error: { code: -32090, message: "CH is reconnecting" } });
            else response.end();
          }
          return;
        }
        if (response.destroyed || response.writableEnded) return;
        if (!response.headersSent)
          response.writeHead(200, {
            "content-type": "application/x-ndjson",
            "cache-control": "no-store",
          });
        if (response.writableLength > 256 * 1024) {
          response.destroy();
          return;
        }
        response.write(JSON.stringify(event) + "\n");
      }, after);
      const heartbeat = setInterval(() => {
        if (response.headersSent && !response.writableEnded) response.write("\n");
      }, 15_000);
      heartbeat.unref();
      response.on("close", () => {
        clearInterval(heartbeat);
        stop();
      });
      return;
    }
    if (request.method !== "POST") {
      reply(404, { error: { code: -32601, message: "Not found" } });
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const part = Buffer.from(chunk as Uint8Array);
      size += part.length;
      if (size > 1024 * 1024) throw new Error("Client request is too large");
      chunks.push(part);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Expected a request object");
    const input = value as Record<string, unknown>;
    if (route === "/v1/snapshot" && typeof input.threadId === "string")
      reply(200, { result: await channel.snapshot(input.threadId) });
    else if (route === "/v1/respond")
      reply(200, { result: await channel.respond(clientChannelResponseSchema.parse(input)) });
    else if (
      route === "/v1/rpc" &&
      typeof input.method === "string" &&
      input.params &&
      typeof input.params === "object" &&
      !Array.isArray(input.params)
    )
      reply(200, {
        result: await channel.request(input.method, input.params as Record<string, unknown>),
      });
    else reply(404, { error: { code: -32601, message: "Not found" } });
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    reply(400, {
      error: {
        code:
          error instanceof Error && "code" in error && typeof error.code === "number"
            ? error.code
            : -32603,
        message: error instanceof Error ? error.message : "Client operation failed",
      },
    });
  }
}
