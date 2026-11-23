import { randomUUID } from "node:crypto";
import * as c from "@codexhost/shared-contracts";
import { PeerHostClient } from "./peer-host-client.ts";
import { PeerHostStore, parseConnectionLink, type PeerRecord } from "./peer-host-store.ts";
import type { EventHub, RpcRegistry } from "./transport.ts";
import { requestOf } from "./store.ts";
import type { RemoteSessionCall } from "./remote-session-delivery.ts";
export class PeerHostManager {
  private clients = new Map<string, PeerHostClient>();
  onChange?: () => void;
  constructor(
    private store: PeerHostStore,
    private origins: () => Promise<string[]>,
    private events: EventHub,
  ) {
    for (const record of store.load()) this.install(record);
  }
  private changed = () => {
    this.events.emit(c.REMOTE_PEERS_CHANGED_EVENT);
    this.onChange?.();
  };
  private install(record: PeerRecord, client = new PeerHostClient(record, this.changed)) {
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
    for (const [action, method] of Object.entries(c.REMOTE_PEERS_METHODS))
      rpc.register(method, async (args, ctx) => {
        if (!ctx.auth) throw Error("Authentication required");
        const input = requestOf(args);
        if (action === "list") return { peers: [...this.clients.values()].map((p) => p.summary()) };
        if (action === "add" || action === "test") {
          const p =
            action === "add"
              ? c.remotePeerAddParamsSchema.parse(input)
              : c.remotePeerTestParamsSchema.parse(input);
          const conn = parseConnectionLink(
            "peerId" in p && p.peerId ? this.get(p.peerId).record : p,
          );
          await this.check(conn.origin);
          const now = new Date().toISOString();
          const record = {
            peerId: randomUUID(),
            name:
              "name" in p && typeof p.name === "string" ? p.name : new URL(conn.origin).hostname,
            origin: conn.origin,
            token: conn.token,
            enabled: true,
            createdAt: now,
            updatedAt: now,
          };
          const client = new PeerHostClient(record, this.changed);
          try {
            await client.probe();
          } catch (e) {
            if (action === "test")
              return { ok: false, error: e instanceof Error ? e.message : "Probe failed" };
            throw e;
          }
          if (action === "test")
            return c.remotePeerTestResultSchema.parse({ ...client.summary(), ok: true });
          this.store.save([...this.records(), record]);
          const installed = this.install(record, client);
          this.changed();
          return { peer: installed.summary() };
        }
        const { peerId } = c.remotePeerIdParamsSchema.parse(input);
        const client = this.get(peerId);
        switch (action) {
          case "remove":
            this.store.save(this.records().filter((r) => r.peerId !== peerId));
            client.close();
            this.clients.delete(peerId);
            this.changed();
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
            this.changed();
            return { peer: next.summary() };
          }
          case "reconnect": {
            const next = this.install(client.record);
            this.changed();
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
