/** Protocol fixture only. Real owner arbitration is tested in host-runtime. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  clientThreadSnapshotSchema,
  type ClientInteraction,
  type ClientChannelResponse,
  type ClientSnapshotOptions,
  type ClientThreadSnapshot,
} from "@codexhost/shared-contracts";
import type { HostClientUpdate } from "@codexhost/desktop-control";
import type { ChTurn } from "../../src/ch-thread-view.ts";
import { FakeChHost } from "./ch-host.ts";

export class FakeChChannel extends FakeChHost {
  epoch = randomUUID();
  sequence = 0;
  online = true;
  snapshots = 0;
  listeners = new Set<(event: HostClientUpdate) => void>();
  pending: ClientInteraction[] = [];
  answers: ClientChannelResponse[] = [];
  commands = new Map<string, NonNullable<ClientThreadSnapshot["command"]>>();
  delaySnapshot: (() => Promise<void>) | undefined;
  /** Options of every snapshot request, in order. */
  snapshotOptions: ClientSnapshotOptions[] = [];
  /** False models an older Host that ignores `knownTurns` and sends full Turns. */
  supportsKnownTurns = true;
  /** Placeholders sent in each snapshot reply, in order. */
  snapshotPlaceholders: number[] = [];
  /** Models a Host bug: answers any non-empty `knownTurns` with mismatching placeholders. */
  forgeUnchanged = false;
  readonly realtime = {
    request: <T>(method: string, params: Record<string, unknown>) =>
      this.request<T>(method, params),
    subscribe: (listener: (event: HostClientUpdate) => void) => {
      this.listeners.add(listener);
      listener({ type: "connection", online: this.online });
      if (this.online)
        listener({
          type: "hello",
          version: 1,
          cursor: { epoch: this.epoch, sequence: this.sequence },
          reset: true,
        });
      return () => {
        this.listeners.delete(listener);
      };
    },
    snapshot: (id: string, options?: ClientSnapshotOptions) => this.snapshot(id, options),
    respond: (response: ClientChannelResponse) => this.respond(response),
  };
  changed(id: string, method = "item/agentMessage/delta"): void {
    const event = {
      type: "changed" as const,
      cursor: { epoch: this.epoch, sequence: ++this.sequence },
      threadId: id,
      method,
    };
    if (this.online) for (const listener of this.listeners) listener(event);
  }
  connection(online: boolean): void {
    this.online = online;
    for (const listener of this.listeners) listener({ type: "connection", online });
    if (online)
      for (const listener of this.listeners)
        listener({
          type: "hello",
          version: 1,
          cursor: { epoch: this.epoch, sequence: this.sequence },
          reset: true,
        });
  }
  /** Same contract as the Host: settled Turns carry an epoch-bound fingerprint and
   * become placeholders when the client already holds identical content. */
  private compact(turn: ChTurn, known: NonNullable<ClientSnapshotOptions["knownTurns"]>) {
    if (turn.status === "inProgress") return turn;
    const fingerprint = createHash("sha256")
      .update(this.epoch + JSON.stringify(turn))
      .digest("base64url");
    if (this.forgeUnchanged && known.length)
      return {
        id: turn.id,
        status: turn.status,
        items: [],
        fingerprint: "forged",
        unchanged: true,
      };
    return known.some((entry) => entry.id === turn.id && entry.fingerprint === fingerprint)
      ? { id: turn.id, status: turn.status, items: [], fingerprint, unchanged: true }
      : { ...turn, fingerprint };
  }
  async snapshot(id: string, options: ClientSnapshotOptions = {}): Promise<ClientThreadSnapshot> {
    this.snapshots++;
    this.snapshotOptions.push(structuredClone(options));
    if (!this.online) throw new Error("Host offline");
    const row = this.threads.get(id);
    if (!row) throw new Error("Unknown Thread");
    const value = clientThreadSnapshotSchema.parse({
      cursor: { epoch: this.epoch, sequence: this.sequence },
      command: structuredClone(this.commands.get(id)),
      thread: { ...structuredClone(row), turns: [] },
      turnsPage: {
        data: structuredClone(row.turns.slice(-5).reverse()).map((turn) =>
          this.supportsKnownTurns && options.knownTurns
            ? this.compact(turn, options.knownTurns)
            : turn,
        ),
        nextCursor: row.turns.length > 5 ? row.turns.at(-5)?.id : null,
      },
      configuration: {
        effectiveModel: { id: "native" },
        effectivePermissionModeId: this.modes.get(id) ?? "ask",
      },
      interactions: this.pending.filter((value) => value.threadId === id),
    });
    this.snapshotPlaceholders.push(value.turnsPage.data.filter((turn) => turn.unchanged).length);
    await this.delaySnapshot?.();
    return value;
  }
  async respond(response: ClientChannelResponse): Promise<{ resolved: boolean }> {
    if (!this.online) throw new Error("Host disconnected; outcome unknown");
    if (response.epoch !== this.epoch) throw new Error("Host generation changed");
    const index = this.pending.findIndex(
      (value) => value.requestId === response.requestId && value.threadId === response.threadId,
    );
    if (index !== -1) {
      this.pending.splice(index, 1);
      this.answers.push(response);
      this.changed(response.threadId, "serverRequest/resolved");
    }
    return { resolved: true };
  }
  override async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const result = await super.request<T>(method, params);
    if (method === "turn/start") this.changed(String(params.threadId), "turn/completed");
    if (method === "thread/name/set") this.changed(String(params.threadId), "thread/name/updated");
    return result;
  }
}

export async function startFakeChChannel(host: FakeChChannel, directory: string) {
  const token = randomBytes(32).toString("hex");
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401);
      response.end();
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/v1/events")) {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      const stop = host.realtime.subscribe((event) => {
        if (event.type !== "connection") response.write(JSON.stringify(event) + "\n");
      });
      response.on("close", stop);
      return;
    }
    void (async () => {
      let text = "";
      for await (const chunk of request) text += String(chunk);
      const input = JSON.parse(text) as Record<string, unknown>;
      const result =
        request.url === "/v1/snapshot"
          ? await host.snapshot(String(input.threadId), {
              ...(input.knownTurns ? { knownTurns: input.knownTurns } : {}),
              ...(input.truncateToolOutput ? { truncateToolOutput: true } : {}),
            } as ClientSnapshotOptions)
          : request.url === "/v1/respond"
            ? await host.respond(input as unknown as ClientChannelResponse)
            : await host.request(String(input.method), input.params as Record<string, unknown>);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ result }));
    })().catch((error: unknown) => {
      response.writeHead(400);
      response.end(
        JSON.stringify({
          error: { message: error instanceof Error ? error.message : String(error) },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `host-${process.pid}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      port: (server.address() as AddressInfo).port,
      token,
      startedAt: Date.now(),
      epoch: host.epoch,
    }),
    { mode: 0o600 },
  );
  return {
    close: async () => {
      rmSync(file, { force: true });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
