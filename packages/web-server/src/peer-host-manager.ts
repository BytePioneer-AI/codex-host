import { randomUUID } from "node:crypto";
import * as c from "@codexhost/shared-contracts";
import { PeerHostClient } from "./peer-host-client.ts";
import { parseConnectionLink, type PeerHostStore, type PeerRecord } from "./peer-host-store.ts";
import { RpcError, type EventHub, type RpcRegistry } from "./transport.ts";
import { requestOf } from "./store.ts";
import type { RemoteSessionCall } from "./remote-session-delivery.ts";

export interface PeerHostManagerOptions {
  /** Allow loopback peer origins (used for local integration tests / explicit dev opt-in). */
  allowLoopback?: boolean;
  /** Override NDJSON event stream idle timeout in milliseconds. */
  streamIdleTimeoutMs?: number;
}

const LOCAL_ONLY_ACTIONS = new Set(["add", "update", "remove", "test"]);

export class PeerHostManager {
  private clients = new Map<string, PeerHostClient>();
  private readonly allowLoopback: boolean;
  private readonly streamIdleTimeoutMs: number | undefined;
  onChange?: (hostId?: string) => void;

  constructor(
    private store: PeerHostStore,
    private origins: () => Promise<string[]>,
    private events: EventHub,
    options: PeerHostManagerOptions = {},
  ) {
    this.allowLoopback = options.allowLoopback === true;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs;
    for (const record of store.load()) this.install(record);
  }

  private changed = (hostId?: string) => {
    this.events.emit(c.REMOTE_PEERS_CHANGED_EVENT);
    this.onChange?.(hostId);
  };

  private createClient(record: PeerRecord) {
    return new PeerHostClient(record, this.changed, {
      ...(this.streamIdleTimeoutMs === undefined
        ? {}
        : { streamIdleTimeoutMs: this.streamIdleTimeoutMs }),
    });
  }

  private install(record: PeerRecord, client = this.createClient(record)) {
    this.clients.get(record.peerId)?.close();
    this.clients.set(record.peerId, client);
    void client.start();
    return client;
  }

  private get(id: string) {
    const client = this.clients.get(id);
    if (!client) throw Error("Unknown remote peer");
    return client;
  }

  private records() {
    return [...this.clients.values()].map((p) => p.record);
  }

  private async check(origin: string) {
    if ((await this.origins()).some((s) => URL.parse(s)?.origin === origin))
      throw Error("Cannot pair this server with itself");
  }

  hosts() {
    return [...this.clients.values()].map((p) => ({
      hostId: c.remotePeerHostId(p.record.peerId),
      online: p.state === "connected",
      displayName: p.record.name,
      state: p.state,
      projects: p.manifest?.projects,
      epoch: p.manifest?.epoch,
    }));
  }

  call(op: c.RemoteSessionOperation) {
    if (op.kind === "hosts") return Promise.resolve(this.hosts());
    return this.get(c.peerIdFromRemoteHostId(op.hostId) ?? "").call(op);
  }

  register(rpc: RpcRegistry) {
    const linkOptions = { allowLoopback: this.allowLoopback };
    for (const [action, method] of Object.entries(c.REMOTE_PEERS_METHODS))
      rpc.register(method, async (args, ctx) => {
        if (!ctx.auth) throw new RpcError("auth/required", "Authentication required");
        if (LOCAL_ONLY_ACTIONS.has(action) && !ctx.auth.local) {
          throw new RpcError(
            "auth/local-required",
            "Manage remote peers from a local session on this machine.",
          );
        }
        const input = requestOf(args);
        if (action === "list") return { peers: [...this.clients.values()].map((p) => p.summary()) };
        if (action === "add" || action === "test") {
          const p =
            action === "add"
              ? c.remotePeerAddParamsSchema.parse(input)
              : c.remotePeerTestParamsSchema.parse(input);
          const conn = parseConnectionLink(
            "peerId" in p && p.peerId ? this.get(p.peerId).record : p,
            linkOptions,
          );
          await this.check(conn.origin);
          const now = new Date().toISOString();
          const explicitName =
            "name" in p && typeof p.name === "string" && p.name.trim() ? p.name.trim() : undefined;
          const record = {
            peerId: randomUUID(),
            name: explicitName ?? new URL(conn.origin).hostname,
            origin: conn.origin,
            token: conn.token,
            enabled: true,
            createdAt: now,
            updatedAt: now,
          };
          const client = this.createClient(record);
          try {
            await client.probe();
          } catch (e) {
            if (action === "test")
              return { ok: false, error: e instanceof Error ? e.message : "Probe failed" };
            throw e;
          }
          if (!explicitName && client.manifest?.hostname) {
            record.name = client.manifest.hostname;
          }
          if (action === "test")
            return c.remotePeerTestResultSchema.parse({ ...client.summary(), ok: true });
          this.store.save([...this.records(), record]);
          const installed = this.install(record, client);
          this.changed(installed.hostId);
          return { peer: installed.summary() };
        }
        const { peerId } = c.remotePeerIdParamsSchema.parse(input);
        const client = this.get(peerId);
        switch (action) {
          case "remove":
            this.store.save(this.records().filter((r) => r.peerId !== peerId));
            client.close();
            this.clients.delete(peerId);
            this.changed(client.hostId);
            return { removed: true };
          case "update": {
            const p = c.remotePeerUpdateParamsSchema.parse(input);
            const old = client.record;
            const conn =
              p.connectionUrl || p.origin || p.token
                ? parseConnectionLink(
                    p.connectionUrl
                      ? p
                      : {
                          origin: p.origin ?? old.origin,
                          token: p.token ?? (p.origin ? undefined : old.token),
                        },
                    linkOptions,
                  )
                : old;
            await this.check(conn.origin);
            if (this.get(peerId) !== client) throw Error("Peer changed");
            const record = {
              ...old,
              origin: conn.origin,
              token: conn.token,
              enabled: p.enabled ?? old.enabled,
              name: p.name ?? old.name,
              updatedAt: new Date().toISOString(),
            };
            this.store.save(this.records().map((r) => (r.peerId === peerId ? record : r)));
            const next = this.install(record);
            this.changed(next.hostId);
            return { peer: next.summary() };
          }
          case "reconnect": {
            const next = this.install(client.record);
            this.changed(next.hostId);
            return { peer: next.summary() };
          }
          case "listDirs":
            return client.listDirs(c.remotePeerListDirsParamsSchema.parse(input).path);
          case "createDir": {
            const p = c.remotePeerCreateDirParamsSchema.parse(input);
            return client.createDir(p.parentPath, p.name);
          }
          case "createWorkspace":
            return client.createWorkspace(c.remotePeerCreateWorkspaceParamsSchema.parse(input));
          case "renameWorkspace":
            return client.renameWorkspace(c.remotePeerRenameWorkspaceParamsSchema.parse(input));
          case "deleteWorkspace":
            return client.deleteWorkspace(
              c.remotePeerDeleteWorkspaceParamsSchema.parse(input).workspaceId,
            );
          default:
            throw Error("Unknown peer method");
        }
      });
  }

  close() {
    for (const p of this.clients.values()) p.close();
  }
}

export function createCompositeRemoteCall(
  manager: PeerHostManager,
  desktop: RemoteSessionCall,
): RemoteSessionCall {
  return async (op) => {
    if (op.kind === "hosts") {
      const [peers, others] = await Promise.all([
        manager.hosts(),
        Promise.resolve()
          .then(() => desktop(op))
          .catch(() => []),
      ]);
      return [...peers, ...(Array.isArray(others) ? others : [])];
    }
    return op.hostId.startsWith("remote-peer:") ? manager.call(op) : desktop(op);
  };
}
