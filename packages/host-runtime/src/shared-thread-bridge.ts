import { lstat } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import type { JsonObject, JsonRpcRequest } from "@codexhost/protocol-core";
import { classifyCreateRequestRoute } from "./app-server-host.js";
import { threadOwnershipListResultSchema } from "@codexhost/shared-contracts";
import {
  storedSectionPlacementV1Schema,
  type StoredSectionPlacementV1,
} from "@codexhost/mapping-store";
import { createRemoteOfficialAppServerConnection } from "./remote-official-connection.js";
import { object, StreamThreadPeer, type SharedThreadPeer } from "./shared-thread-peer.js";

export function sharedThreadSocketPath(environment: NodeJS.ProcessEnv): string {
  return path.join(
    environment.CODEX_HOME ?? path.join(environment.HOME ?? homedir(), ".codex"),
    "app-server-control",
    "codexhost-threads.sock",
  );
}

export async function connectSharedThreads(
  environment: NodeJS.ProcessEnv,
): Promise<SharedThreadPeer | null> {
  if (process.platform === "win32") return null;
  const socketPath = sharedThreadSocketPath(environment);
  const metadata = await lstat(socketPath).catch(() => null);
  if (!metadata) return null;
  if (
    !metadata.isSocket() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("Shared Thread socket must be private and owned by the current user");
  }
  // A stale socket after a crash is an offline service, not a failure of the
  // GUI's independent native Codex connection. Never retry a submitted write.
  const connection = await createRemoteOfficialAppServerConnection(socketPath).catch(() => null);
  if (!connection) return null;
  connection.stderr.resume();
  return new StreamThreadPeer(connection.stdout, connection.stdin, () => connection.close());
}

/** A GUI keeps its native Codex connection and forwards only shared external Threads. */
export class SharedThreadBridge {
  readonly #known = new Set<string>();
  #peer: SharedThreadPeer | null = null;
  #connecting: Promise<SharedThreadPeer | null> | null = null;
  #closed = false;
  #timer: NodeJS.Timeout | undefined;
  #publish: (message: JsonObject) => void = () => undefined;

  constructor(
    readonly options: {
      connect(): Promise<SharedThreadPeer | null>;
      delegateCreates: boolean;
      diagnose(error: unknown): void;
    },
  ) {}

  start(publish: (message: JsonObject) => void): void {
    this.#publish = publish;
    const discover = (): void => {
      void this.#connect().catch(this.options.diagnose);
    };
    discover();
    this.#timer = setInterval(discover, 3_000);
    this.#timer.unref();
  }

  async #connect(): Promise<SharedThreadPeer | null> {
    if (this.#closed) return null;
    if (this.#peer) return this.#peer;
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.options
      .connect()
      .then(async (peer) => {
        if (!peer) return null;
        if (this.#closed) {
          peer.close();
          return null;
        }
        this.#peer = peer;
        peer.subscribe((message) => {
          const params = object(message.params) ? message.params : {};
          if (
            object(params.thread) &&
            params.thread.modelProvider === "codexhost" &&
            typeof params.thread.id === "string"
          ) {
            this.#known.add(params.thread.id);
          }
          this.#publish(message);
        });
        void peer.closed.then(() => {
          if (this.#peer === peer) this.#peer = null;
        });
        // Announce existing Threads when a GUI starts or the SSH service is discovered later.
        for (const thread of await this.#rows(peer, {})) {
          this.#publish({ method: "thread/started", params: { thread }, emittedAtMs: Date.now() });
        }
        return peer;
      })
      .catch((error: unknown) => {
        this.#peer?.close();
        this.#peer = null;
        throw error;
      })
      .finally(() => {
        this.#connecting = null;
      });
    return this.#connecting;
  }

  async ownership(threadIds: string[]): Promise<Map<string, string>> {
    const peer = await this.#connect().catch((error: unknown) => {
      if (this.options.delegateCreates || threadIds.some((id) => this.#known.has(id))) throw error;
      this.options.diagnose(error);
      return null;
    });
    if (!peer) {
      if (threadIds.some((id) => this.#known.has(id)))
        throw new Error("Shared Thread Host is disconnected");
      return new Map();
    }
    const response = await peer.request("codexhost/thread/ownership/list", { threadIds });
    const result = threadOwnershipListResultSchema.parse(response.result);
    const owners = new Map<string, string>();
    for (const thread of result.threads) {
      if (thread.owner === "external") {
        owners.set(thread.threadId, thread.harnessId);
        this.#known.add(thread.threadId);
      }
    }
    return owners;
  }

  async route(request: JsonRpcRequest, defaultAgent: "codex" | "pi"): Promise<JsonObject | null> {
    const params = object(request.params) ? request.params : {};
    const create = this.options.delegateCreates
      ? classifyCreateRequestRoute(request, defaultAgent)
      : null;
    let shared = create !== null && create.selectedHarness !== "codex";
    if (!shared && typeof params.threadId === "string") {
      shared =
        this.#known.has(params.threadId) ||
        (await this.ownership([params.threadId])).has(params.threadId);
    }
    if (!shared) return null;
    const peer = await this.#connect();
    if (!peer) throw new Error("Shared Thread Host is disconnected");
    return { ...(await peer.request(request.method, params)), id: request.id };
  }

  async #rows(peer: SharedThreadPeer, params: JsonObject): Promise<JsonObject[]> {
    const rows: JsonObject[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const reply = await peer.request("thread/list", { ...params, cursor, limit: 200 });
      if (!object(reply.result) || !Array.isArray(reply.result.data))
        throw new Error("Shared Thread list failed");
      for (const row of reply.result.data) {
        if (!object(row) || typeof row.id !== "string")
          throw new Error("Invalid shared Thread row");
        rows.push(row);
        this.#known.add(row.id);
      }
      const next = reply.result.nextCursor;
      if (next !== null && typeof next !== "string")
        throw new Error("Invalid shared Thread cursor");
      if (typeof next === "string" && seen.has(next))
        throw new Error("Shared Thread pagination did not advance");
      cursor = next;
      if (cursor) seen.add(cursor);
    } while (cursor !== null);
    return rows;
  }

  async list(params: JsonObject): Promise<JsonObject[]> {
    const peer = await this.#connect();
    return peer
      ? this.#rows(
          peer,
          params.sortKey === "section_position" ? { ...params, sortKey: "updated_at" } : params,
        )
      : [];
  }

  async placements(): Promise<StoredSectionPlacementV1[]> {
    const peer = await this.#connect();
    if (!peer) return [];
    const reply = await peer.request("codexhost/shared-threads/placements", {});
    return storedSectionPlacementV1Schema.array().parse(reply.result);
  }

  async respond(message: unknown): Promise<boolean> {
    if (
      !object(message) ||
      typeof message.method === "string" ||
      typeof message.id !== "string" ||
      !message.id.startsWith("shared-interaction:")
    )
      return false;
    if (!this.#peer) throw new Error("Shared Thread Host is disconnected");
    await this.#peer.respond(message);
    return true;
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#peer?.close();
    this.#peer = null;
  }
}
