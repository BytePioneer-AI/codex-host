import { randomUUID } from "node:crypto";
import * as c from "@codexhost/shared-contracts";
import { PeerChHostClient } from "./peer-ch-host-client.ts";
import { PeerHostClient } from "./peer-host-client.ts";
import { parseConnectionLink, type PeerHostStore, type PeerRecord } from "./peer-host-store.ts";
import { PeerThreadSource, type PeerThreadProjector } from "./peer-thread-source.ts";
import { RpcError, type EventHub, type RpcRegistry } from "./transport.ts";
import { requestOf } from "./store.ts";
import type { RemoteSessionCall } from "./remote-session-delivery.ts";

export interface PeerHostManagerOptions {
  /** Allow loopback peer origins (used for local integration tests / explicit dev opt-in). */
  allowLoopback?: boolean;
  /** Override NDJSON event stream idle timeout in milliseconds. */
  streamIdleTimeoutMs?: number;
  /** Optional placeholder attachment/image projector for Peer thread views. */
  projector?: (threadId: string) => PeerThreadProjector;
}

export class PeerHostManager {
  private clients = new Map<string, PeerHostClient>();
  private sources = new Map<string, PeerThreadSource>();
  private readonly allowLoopback: boolean;
  private readonly streamIdleTimeoutMs: number | undefined;
  private readonly projector: ((threadId: string) => PeerThreadProjector) | undefined;
  onChange?: (hostId?: string) => void;
  onPeerRemoved?: (hostId: string) => void;
  onThreadChanged?: (hostId: string, threadId: string) => unknown;
  onUsageChanged?: (hostId: string, threadId: string) => void;
  onCatalogInspectionChanged?: (hostId: string) => void;
  onSkillsChanged?: (hostId: string) => void;
  onConnection?: (hostId: string, online: boolean) => void;
  onReset?: (hostId: string, epoch: string, full: boolean) => void;

  constructor(
    private store: PeerHostStore,
    private origins: () => Promise<string[]>,
    private events: EventHub,
    options: PeerHostManagerOptions = {},
  ) {
    this.allowLoopback = options.allowLoopback === true;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs;
    this.projector = options.projector;
    for (const record of store.load()) this.install(record);
  }

  private changed = (hostId?: string) => {
    this.events.emit(c.REMOTE_PEERS_CHANGED_EVENT);
    this.onChange?.(hostId);
  };

  private createClient(record: PeerRecord, initialManifest?: c.RemotePeerManifest) {
    return new PeerHostClient(record, this.changed, {
      ...(this.streamIdleTimeoutMs === undefined
        ? {}
        : { streamIdleTimeoutMs: this.streamIdleTimeoutMs }),
      ...(initialManifest === undefined ? {} : { initialManifest }),
    });
  }

  private install(record: PeerRecord, client?: PeerHostClient) {
    const previous = this.clients.get(record.peerId);
    const inheritedManifest =
      !client && record.enabled && previous && previous.record.origin === record.origin
        ? previous.manifest
        : undefined;
    const next = client ?? this.createClient(record, inheritedManifest);
    this.sources.get(record.peerId)?.close();
    this.sources.delete(record.peerId);
    previous?.close();
    this.clients.set(record.peerId, next);
    if (record.enabled) {
      const host = new PeerChHostClient(next.chTransport());
      const source = new PeerThreadSource({
        hostId: next.hostId,
        host,
        onCatalogChanged: () => this.onChange?.(next.hostId),
        onThreadChanged: (threadId) => this.onThreadChanged?.(next.hostId, threadId),
        onUsageChanged: (threadId) => this.onUsageChanged?.(next.hostId, threadId),
        onCatalogInspectionChanged: () => this.onCatalogInspectionChanged?.(next.hostId),
        onSkillsChanged: () => this.onSkillsChanged?.(next.hostId),
        onConnection: (online) => this.onConnection?.(next.hostId, online),
        onReset: (epoch, full) => this.onReset?.(next.hostId, epoch, full),
        ...(this.projector ? { projector: this.projector } : {}),
      });
      this.sources.set(record.peerId, source);
    }
    void next.start();
    return next;
  }

  client(hostId: string): PeerHostClient | undefined {
    const peerId = c.peerIdFromRemoteHostId(hostId);
    return peerId === undefined ? undefined : this.clients.get(peerId);
  }

  /** Server-internal list of configured peer access tokens for error-envelope scrubbing. */
  peerTokens(): string[] {
    const tokens = new Set<string>();
    for (const client of this.clients.values()) {
      if (typeof client.record.token === "string" && client.record.token.length > 0) {
        tokens.add(client.record.token);
      }
    }
    return [...tokens];
  }

  source(hostId: string): PeerThreadSource | undefined {
    const peerId = c.peerIdFromRemoteHostId(hostId);
    return peerId === undefined ? undefined : this.sources.get(peerId);
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
    return [...this.clients.values()]
      .filter((p) => p.record.enabled)
      .map((p) => ({
        hostId: c.remotePeerHostId(p.record.peerId),
        online: p.state === "connected",
        displayName: p.record.name,
        ...(p.record.color !== undefined ? { color: p.record.color } : {}),
        state: p.state,
        projects: p.manifest?.projects,
        epoch: p.manifest?.epoch,
      }));
  }

  /** Agent-safe summaries of enabled peers for cross-host delegation discovery (no tokens or URLs). */
  delegationHosts(): c.PeerDelegationHostSummary[] {
    return [...this.clients.values()]
      .filter((p) => p.record.enabled)
      .map((p) => ({
        hostId: c.remotePeerHostId(p.record.peerId),
        displayName: p.record.name,
        online: p.state === "connected",
        state: p.state,
        delegation: p.state === "connected" && p.manifest?.capabilities?.delegation === 1,
        projects: (p.manifest?.projects ?? []).map(({ id, name, path }) => ({ id, name, path })),
        ...(p.manifest?.platform !== undefined ? { platform: p.manifest.platform } : {}),
        ...(p.manifest?.hostname !== undefined ? { hostname: p.manifest.hostname } : {}),
        ...(p.manifest?.homeDir !== undefined ? { homeDir: p.manifest.homeDir } : {}),
      }));
  }

  call(op: c.RemoteSessionOperation) {
    if (op.kind === "hosts") return Promise.resolve(this.hosts());
    return this.get(c.peerIdFromRemoteHostId(op.hostId) ?? "").call(op);
  }

  register(rpc: RpcRegistry) {
    const linkOptions = { allowLoopback: this.allowLoopback };
    const localOnlyActions = new Set(["add", "update", "remove", "test"]);
    for (const [action, method] of Object.entries(c.REMOTE_PEERS_METHODS))
      rpc.register(method, async (args, ctx) => {
        if (!ctx.auth) throw new RpcError("auth/required", "Authentication required");
        if (localOnlyActions.has(action) && ctx.auth.local !== true) {
          throw new RpcError(
            "auth/local-required",
            "Managing remote peers requires a local authenticated session",
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
          const explicitColor = "color" in p ? p.color : undefined;
          const record: PeerRecord = {
            peerId: randomUUID(),
            name: explicitName ?? new URL(conn.origin).hostname,
            ...(explicitColor !== undefined ? { color: explicitColor } : {}),
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
            return c.remotePeerTestResultSchema.parse({
              ...client.summary(),
              projects: client.manifest?.projects.map(({ id, name, path }) => ({
                id,
                name,
                path,
              })),
              ok: true,
            });
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
            this.sources.get(peerId)?.close();
            this.sources.delete(peerId);
            client.close();
            this.clients.delete(peerId);
            this.onPeerRemoved?.(client.hostId);
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
            if (conn.origin !== old.origin) {
              await this.check(conn.origin);
              if (this.get(peerId) !== client) throw Error("Peer changed");
            }
            const nextColor = p.color === undefined ? old.color : (p.color ?? undefined);
            const record: PeerRecord = {
              ...old,
              origin: conn.origin,
              token: conn.token,
              enabled: p.enabled ?? old.enabled,
              name: p.name ?? old.name,
              updatedAt: new Date().toISOString(),
            };
            if (nextColor !== undefined) {
              record.color = nextColor;
            } else {
              delete record.color;
            }
            this.store.save(this.records().map((r) => (r.peerId === peerId ? record : r)));
            if (
              record.enabled === old.enabled &&
              record.origin === old.origin &&
              record.token === old.token
            ) {
              client.record = record;
              this.changed(client.hostId);
              return { peer: client.summary() };
            }
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
    for (const s of this.sources.values()) s.close();
    this.sources.clear();
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
