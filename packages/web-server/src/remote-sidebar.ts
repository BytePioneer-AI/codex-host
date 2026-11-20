import type { ServerResponse } from "node:http";
import {
  sidebarIdentityField,
  sidebarStream,
  sidebarUnary,
  type SidebarAction,
} from "@codexhost/shared-contracts";
import { z } from "zod";
import { RpcError, type StreamSink } from "./transport.ts";

type Channel = (action: SidebarAction) => Promise<unknown>;
type Resolve = (id: string) => Promise<Channel>;
const envelope = z.object({
  method: z.string(),
  rpcId: z.string(),
  payload: z.object({ args: z.record(z.string(), z.unknown()) }),
});
const message = z.discriminatedUnion("type", [
  z.object({ type: z.literal("item"), value: z.unknown() }),
  z.object({ type: z.literal("end") }),
  z.object({
    type: z.literal("error"),
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
]);
const failure = (e: unknown) => ({
  code: e instanceof RpcError ? e.code : "remote/sidebar-unavailable",
  message: e instanceof Error ? e.message : "Remote panel connection failed.",
  details: {},
});
export class RemoteSidebar {
  constructor(private readonly resolve: Resolve) {}
  private source(method: string, args: Record<string, unknown>) {
    const key = sidebarIdentityField(method);
    const id = args[key];
    if (typeof id !== "string" || !id.startsWith("web-remote:")) return;
    const rest = { ...args };
    delete rest.agentId;
    delete rest.workspaceFileScopeId;
    delete rest.sessionId;
    return { id, args: rest };
  }
  async unary(body: string, response: ServerResponse) {
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      return false;
    }
    const parsed = envelope.safeParse(value);
    if (!parsed.success) return false;
    const { method, rpcId, payload } = parsed.data;
    const name = sidebarUnary.safeParse(method);
    if (!name.success) return false;
    const source = this.source(method, payload.args);
    if (!source) return false;
    try {
      const send = await this.resolve(source.id);
      const reply = z
        .object({ contentType: z.string(), base64: z.string() })
        .parse(await send({ type: "unary", method: name.data, rpcId, args: source.args }));
      const bytes = Buffer.from(reply.base64, "base64");
      if (
        !/^(application\/json|multipart\/form-data)(;|$)/iu.test(reply.contentType) ||
        /[\r\n]/u.test(reply.contentType)
      )
        throw new Error("Invalid remote panel response.");
      response
        .writeHead(200, {
          "content-type": reply.contentType,
          "content-length": bytes.length,
          "cache-control": "no-store",
        })
        .end(bytes);
    } catch (error) {
      response
        .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        .end(
          JSON.stringify({
            type: "server-response",
            rpcId,
            result: { ok: false, error: failure(error) },
          }),
        );
    }
    return true;
  }
  stream(method: string, args: Record<string, unknown>, sink: StreamSink) {
    const name = sidebarStream.safeParse(method);
    if (!name.success) return false;
    const source = this.source(method, args);
    if (!source) return false;
    void this.follow(source.id, name.data, source.args, sink).catch((error) => {
      if (!sink.closed) {
        const f = failure(error);
        sink.fail(f.code, f.message);
      }
    });
    return true;
  }
  private async follow(
    id: string,
    method: z.infer<typeof sidebarStream>,
    args: Record<string, unknown>,
    sink: StreamSink,
  ) {
    const send = await this.resolve(id);
    if (sink.closed) return;
    const { handle } = z
      .object({ handle: z.uuid() })
      .parse(await send({ type: "open", method, args }));
    let finished = false;
    const close = () => {
      if (!finished) {
        finished = true;
        void send({ type: "close", handle }).catch(() => undefined);
      }
    };
    sink.onClose(close);
    if (method === "terminal/attach" && sink.input) {
      const input = sink.input;
      void (async () => {
        for await (const value of input.items) {
          if (finished) return;
          const payload = Buffer.from(JSON.stringify(value)).toString("base64");
          for (let i = 0; i < payload.length && !finished; i += 8192)
            await send({
              type: "input",
              handle,
              chunk: payload.slice(i, i + 8192),
              final: i + 8192 >= payload.length,
            });
        }
        if (!finished) await send({ type: "end", handle });
      })().catch((error) => {
        if (!finished) {
          const f = failure(error);
          sink.fail(f.code, f.message);
          close();
        }
      });
    }
    try {
      while (!finished && !sink.closed) {
        const page = z
          .object({ frames: z.array(message), closed: z.boolean() })
          .parse(await send({ type: "poll", handle }));
        for (const frame of page.frames) {
          if (sink.closed) return;
          if (frame.type === "end") {
            sink.end();
            return;
          }
          if (frame.type === "error") {
            sink.fail(frame.error.code, frame.error.message, frame.error.details);
            return;
          }
          sink.push(frame.value);
        }
        if (page.closed) throw new Error("Target Host closed the panel connection.");
      }
    } finally {
      close();
    }
  }
}
