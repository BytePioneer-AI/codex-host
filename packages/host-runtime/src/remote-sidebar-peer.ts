import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { z } from "zod";
import { sidebarAction, sidebarIdentityField } from "@codexhost/shared-contracts";

const parameters = z.strictObject({
  nativeId: z
    .string()
    .min(1)
    .max(1024)
    .refine((id) => !id.startsWith("web-remote:") && !id.startsWith("draft-")),
  action: sidebarAction,
});
const maxBody = 10 * 1024 * 1024;
interface Feed {
  nativeId: string;
  socket: WebSocket;
  frames: string[];
  bytes: number;
  part: string;
  closed: boolean;
  wake?(): void;
  lease: NodeJS.Timeout;
}

/** Talks only to the target user's running loopback Web service. Credentials stay on this Host. */
export class RemoteSidebarPeer {
  private feeds = new Map<string, Feed>();
  constructor(private readonly directory: string) {}
  static forEnvironment(environment: NodeJS.ProcessEnv) {
    return new RemoteSidebarPeer(
      environment.CODEXHOST_SHARED_DATA_DIR ??
        (environment.CODEXHOST_REMOTE_SSH_MANAGED === "1"
          ? undefined
          : environment.CODEXHOST_DATA_DIR) ??
        join(environment.HOME ?? homedir(), ".codexhost"),
    );
  }
  private async access() {
    try {
      const file = await open(
        join(this.directory, "web-service-ready.json"),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      let record: { pid: number; web_pid: number; loginUrl: string };
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.size > 16384 ||
          (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
        )
          throw new Error();
        record = JSON.parse(await file.readFile("utf8")) as typeof record;
      } finally {
        await file.close();
      }
      if (
        !Number.isInteger(record.pid) ||
        record.pid <= 0 ||
        !Number.isInteger(record.web_pid) ||
        record.web_pid <= 0
      )
        throw new Error();
      process.kill(record.pid, 0);
      process.kill(record.web_pid, 0);
      const url = new URL(record.loginUrl);
      const token = url.searchParams.get("token");
      if (
        !token ||
        url.protocol !== "http:" ||
        !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.pathname !== "/"
      )
        throw new Error();
      return {
        origin: url.origin,
        headers: {
          authorization: "Bearer " + token,
          origin: url.origin,
          "content-type": "application/json",
        },
      };
    } catch {
      throw new Error(
        "Start authenticated CodexHost Web on the target Host to use workspace files and terminals.",
      );
    }
  }
  private async post(
    access: Awaited<ReturnType<RemoteSidebarPeer["access"]>>,
    method: string,
    args: Record<string, unknown>,
    rpcId: string,
  ) {
    const response = await fetch(new URL("/api/" + method, access.origin), {
      method: "POST",
      redirect: "error",
      headers: access.headers,
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({ type: "client-request", rpcId, method, payload: { args } }),
    });
    if (!response.ok || !response.body)
      throw new Error("The target Web service rejected the panel request.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBody) throw new Error("This file exceeds the remote panel transfer limit.");
      chunks.push(Buffer.from(chunk));
    }
    return {
      contentType: response.headers.get("content-type") ?? "application/json",
      body: Buffer.concat(chunks),
    };
  }
  async run(input: unknown): Promise<unknown> {
    const { nativeId, action } = parameters.parse(input);
    if (action.type === "unary" || action.type === "open") {
      const access = await this.access();
      // A remote service may not have opened the sidebar or listed this Thread yet.
      const loaded = await this.post(
        access,
        "session/list",
        { request: { sessionId: nativeId } },
        "sidebar-lookup",
      );
      const lookup = z
        .object({
          result: z.object({
            ok: z.literal(true),
            value: z.object({ items: z.array(z.object({ sessionId: z.string() })) }),
          }),
        })
        .safeParse(JSON.parse(loaded.body.toString()));
      if (
        !lookup.success ||
        !lookup.data.result.value.items.some((row) => row.sessionId === nativeId)
      )
        throw new Error("The target Web service could not resolve this Thread.");
      const args = { ...action.args };
      delete args.agentId;
      delete args.sessionId;
      delete args.workspaceFileScopeId;
      args[sidebarIdentityField(action.method)] = nativeId;
      if (action.type === "unary") {
        const { contentType, body } = await this.post(access, action.method, args, action.rpcId);
        return { contentType, base64: body.toString("base64") };
      }
      if (this.feeds.size >= 128) throw new Error("Too many open remote panel streams.");
      const url = new URL("/api/remote.mux", access.origin);
      url.protocol = "ws:";
      const socket = new WebSocket(url, {
        headers: access.headers,
        handshakeTimeout: 8000,
        maxPayload: maxBody,
      });
      const handle = randomUUID();
      const feed: Feed = {
        nativeId,
        socket,
        frames: [],
        bytes: 0,
        part: "",
        closed: false,
        lease: setTimeout(() => this.drop(handle), 60000).unref(),
      };
      this.feeds.set(handle, feed);
      const finish = () => {
        feed.closed = true;
        feed.wake?.();
      };
      socket.once("open", () =>
        socket.send(
          JSON.stringify({
            type: "open",
            streamId: handle,
            endpoint: action.method,
            payload: { args },
          }),
        ),
      );
      socket.on("message", (data) => {
        const frame = data.toString();
        const bytes = Buffer.byteLength(frame);
        if (feed.bytes + bytes > maxBody || feed.frames.length >= 1024) {
          socket.terminate();
          finish();
          return;
        }
        feed.frames.push(frame);
        feed.bytes += bytes;
        feed.wake?.();
      });
      socket.on("error", finish);
      socket.on("close", finish);
      try {
        await once(socket, "open", { signal: AbortSignal.timeout(10000) });
      } catch {
        this.drop(handle);
        throw new Error("The target Web service could not open the panel stream.");
      }
      return { handle };
    }
    const feed = this.feeds.get(action.handle);
    if (!feed || feed.nativeId !== nativeId) throw new Error("Remote panel stream expired.");
    feed.lease.refresh();
    if (action.type === "close") {
      this.drop(action.handle);
      return {};
    }
    if (action.type === "poll") {
      if (feed.wake) throw new Error("A remote panel read is already pending.");
      if (!feed.frames.length && !feed.closed)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 12000);
          feed.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      delete feed.wake;
      const frames = feed.frames.splice(0).map((frame) => JSON.parse(frame) as unknown);
      feed.bytes = 0;
      return { frames, closed: feed.closed };
    }
    if (feed.socket.readyState !== WebSocket.OPEN) throw new Error("Remote panel is disconnected.");
    if (action.type === "input") {
      feed.part += action.chunk;
      if (feed.part.length > 360000) {
        this.drop(action.handle);
        throw new Error("Remote panel input is too large.");
      }
      if (action.final) {
        const value: unknown = JSON.parse(Buffer.from(feed.part, "base64").toString("utf8"));
        feed.part = "";
        feed.socket.send(JSON.stringify({ type: "item", streamId: action.handle, value }));
      }
    } else feed.socket.send(JSON.stringify({ type: "end", streamId: action.handle }));
    return {};
  }
  private drop(handle: string) {
    const feed = this.feeds.get(handle);
    if (!feed) return;
    this.feeds.delete(handle);
    clearTimeout(feed.lease);
    feed.closed = true;
    feed.wake?.();
    feed.socket.terminate();
  }
  close() {
    for (const handle of this.feeds.keys()) this.drop(handle);
  }
}
