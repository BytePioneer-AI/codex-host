/**
 * The right Sidebar's DSH backend inside the Web server.
 *
 * Web owns the listener, authentication, the same-origin gate, and the
 * WebSocket mux. This class forwards the Remote namespaces the embedded DSH
 * gateway claims and leaves every other `/api` request with the Web server's
 * own registries.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { createDshWebBackend, type DshWebBackend } from "@codexhost/dsh-web-backend";

import type { StreamSink } from "./transport.ts";

export interface DshWebServicesOptions {
  /** Absolute workspace root the DSH sandbox policy reports. */
  readonly workspaceRoot: string;
  /** Local working directory recorded by the Host for one Thread identity. */
  readonly threadWorkspace: (sessionId: string) => string | undefined;
}

export class DshWebServices {
  private constructor(private readonly backend: DshWebBackend) {}

  /**
   * Mount the DSH services used by the right Sidebar.
   * @param options - workspace root and the local Thread directory seam.
   * @returns the forwarding facade.
   */
  static async open(options: DshWebServicesOptions): Promise<DshWebServices> {
    return new DshWebServices(await createDshWebBackend(options));
  }

  /**
   * Forward one unary DSH Remote request.
   * @param request - the authenticated Web request.
   * @param body - its complete JSON envelope.
   * @param response - the response owned when the gateway claims the endpoint.
   * @returns true when DSH answered; false when the endpoint belongs to Web.
   */
  async handleApiRequest(
    request: IncomingMessage,
    body: string,
    response: ServerResponse,
  ): Promise<boolean> {
    let method: unknown;
    try {
      method = (JSON.parse(body) as { method?: unknown }).method;
    } catch {
      return false;
    }
    if (typeof method !== "string" || !this.backend.handles(method)) return false;
    // A browser that navigates away must cancel the DSH read or conversion it
    // started instead of leaving it running to completion.
    const lifetime = new AbortController();
    const abort = (): void => {
      lifetime.abort(new Error("Web request closed"));
    };
    request.once("close", abort);
    response.once("close", abort);
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const answered = await this.backend.fetch(
        new Request(url, {
          method: "POST",
          headers: {
            "content-type":
              typeof request.headers["content-type"] === "string"
                ? request.headers["content-type"]
                : "application/json",
          },
          body,
          signal: lifetime.signal,
        }),
      );
      const bytes = Buffer.from(await answered.arrayBuffer());
      if (lifetime.signal.aborted || response.destroyed) return true;
      const headers: Record<string, string> = { "cache-control": "no-store" };
      answered.headers.forEach((value, name) => {
        if (name !== "content-length" && name !== "cache-control") headers[name] = value;
      });
      headers["content-length"] = String(bytes.length);
      response.writeHead(answered.status, headers).end(bytes);
      return true;
    } finally {
      request.off("close", abort);
      response.off("close", abort);
    }
  }

  /**
   * Forward one DSH Remote stream into the Web mux.
   * @param endpoint - canonical `<namespace>/<method>` endpoint.
   * @param args - named wire arguments.
   * @param sink - the mux stream to fill.
   * @returns true when DSH owns the endpoint and the stream was opened.
   */
  stream(endpoint: string, args: Record<string, unknown>, sink: StreamSink): boolean {
    if (!this.backend.handles(endpoint)) return false;
    const lifetime = new AbortController();
    sink.onClose(() => lifetime.abort(new Error("Remote stream closed")));
    void (async () => {
      try {
        const source = await this.backend.openStream(endpoint, args, lifetime.signal);
        for await (const value of source) {
          if (sink.closed || lifetime.signal.aborted) break;
          sink.push(value);
        }
        if (!sink.closed) sink.end();
      } catch (error) {
        if (sink.closed || lifetime.signal.aborted) return;
        const failure = this.backend.failure(error);
        sink.fail(failure.code, failure.message);
      }
    })();
    return true;
  }

  async close(): Promise<void> {
    await this.backend.close();
  }
}
