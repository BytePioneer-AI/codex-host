import { randomUUID } from "node:crypto";
import * as c from "@codexhost/shared-contracts";
import { PeerChHostClient } from "./peer-ch-host-client.ts";
import { PeerHostClient } from "./peer-host-client.ts";
import { parseConnectionLink, type PeerHostStore, type PeerRecord } from "./peer-host-store.ts";
import { PeerEndpointError } from "./peer-manifest.ts";
import { syncPeerMesh, type ResolvePeerSelfShare } from "./peer-pairing.ts";
import { PeerThreadSource, type PeerThreadProjector } from "./peer-thread-source.ts";
import { translateContentTextParts, translateThreadLinksFromPeer } from "./peer-thread-links.ts";
import { RpcError, type EventHub, type RpcRegistry } from "./transport.ts";
import { requestOf } from "./store.ts";
import type { RemoteSessionCall } from "./remote-session-delivery.ts";

export interface PeerHostManagerOptions {
  /** Allow loopback peer origins (used for local integration tests / explicit dev opt-in). */
  allowLoopback?: boolean;
  /** Persistent stable nodeId identifying this web-server instance across restarts. */
  localNodeId?: string;
  /** Override NDJSON event stream idle timeout in milliseconds. */
  streamIdleTimeoutMs?: number;
  /** Optional placeholder attachment/image projector for Peer thread views. */
  projector?: (threadId: string) => PeerThreadProjector;
  resolveSelfShare?: ResolvePeerSelfShare;
}

export interface PeerHostRegisterOptions {
  localHostname?: string;
  localDelegationAvailable?: () => boolean;
  localHarnesses?: () => Promise<c.DelegationHostHarnessOption[]>;
}

export class PeerHostManager {
  private clients = new Map<string, PeerHostClient>();
  private sources = new Map<string, PeerThreadSource>();
  private readonly allowLoopback: boolean;
  private readonly localNodeId: string | undefined;
  private readonly streamIdleTimeoutMs: number | undefined;
  private readonly projector: ((threadId: string) => PeerThreadProjector) | undefined;
  private readonly resolveSelfShare: ResolvePeerSelfShare | undefined;
  onChange?: (hostId?: string) => void;
  onPeerRemoved?: (hostId: string) => void;
  onThreadChanged?: (hostId: string, threadId: string) => unknown;
  onThreadConfigurationChanged?: (hostId: string, threadId: string) => void;
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
    this.localNodeId = options.localNodeId;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs;
    this.projector = options.projector;
    this.resolveSelfShare = options.resolveSelfShare;
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
      ...(this.localNodeId === undefined ? {} : { rejectNodeId: this.localNodeId }),
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
      const translateInbound = (text: string) =>
        translateThreadLinksFromPeer(text, {
          sourcePeerNodes: next.manifest?.peerNodes,
          hostIdForNodeId: (nodeId) => this.hostIdForNodeId(nodeId),
        });
      const source = new PeerThreadSource({
        hostId: next.hostId,
        host,
        onCatalogChanged: () => this.onChange?.(next.hostId),
        onThreadChanged: (threadId) => this.onThreadChanged?.(next.hostId, threadId),
        onThreadConfigurationChanged: (threadId) =>
          this.onThreadConfigurationChanged?.(next.hostId, threadId),
        onUsageChanged: (threadId) => this.onUsageChanged?.(next.hostId, threadId),
        onCatalogInspectionChanged: () => this.onCatalogInspectionChanged?.(next.hostId),
        onSkillsChanged: () => this.onSkillsChanged?.(next.hostId),
        onConnection: (online) => this.onConnection?.(next.hostId, online),
        onReset: (epoch, full) => this.onReset?.(next.hostId, epoch, full),
        projector: (threadId) => {
          const base = this.projector?.(threadId);
          return {
            projectInput: (content: unknown[]) =>
              translateContentTextParts(
                base ? base.projectInput(content) : content,
                translateInbound,
              ),
            projectImage: (path: string, projectionKey: string) =>
              base ? base.projectImage(path, projectionKey) : undefined,
            projectText: (text: string) =>
              translateInbound(base?.projectText ? base.projectText(text) : text),
          };
        },
      });
      this.sources.set(record.peerId, source);
    }
    void next.start();
    return next;
  }

  selfNodeId(): string | undefined {
    return this.localNodeId;
  }

  /** Anonymous `remote-peer:<peerId> -> nodeId` map for enabled Peers, preferring connected entries. */
  peerNodes(): Record<string, string> {
    const connected: Array<[string, string]> = [];
    const other: Array<[string, string]> = [];
    for (const client of this.clients.values()) {
      if (!client.record.enabled || !client.manifest?.nodeId) continue;
      const entry: [string, string] = [client.hostId, client.manifest.nodeId];
      if (client.state === "connected") connected.push(entry);
      else other.push(entry);
    }
    return Object.fromEntries([...connected, ...other].slice(0, 128));
  }

  nodeIdForHostId(hostId: string): string | undefined {
    if (hostId === "local") return this.localNodeId;
    const client = this.client(hostId);
    return client?.record.enabled ? client.manifest?.nodeId : undefined;
  }

  hostIdForNodeId(nodeId: string): string | undefined {
    if (!nodeId) return undefined;
    if (this.localNodeId !== undefined && nodeId === this.localNodeId) return "local";
    let fallback: string | undefined;
    for (const client of this.clients.values()) {
      if (!client.record.enabled || client.manifest?.nodeId !== nodeId) continue;
      if (client.state === "connected") return client.hostId;
      fallback ??= client.hostId;
    }
    return fallback;
  }

  client(hostId: string): PeerHostClient | undefined {
    const peerId = c.peerIdFromRemoteHostId(hostId);
    return peerId === undefined ? undefined : this.clients.get(peerId);
  }

  async waitForInitialConnection(hostId: string): Promise<void> {
    await this.client(hostId)?.waitForInitialConnection();
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

  private summarize(client: PeerHostClient): c.RemotePeerSummary {
    const base = client.summary();
    const peerNodes = client.manifest?.peerNodes;
    if (peerNodes === undefined) return base;
    const remoteNodeIds = new Set(Object.values(peerNodes));
    const linkedPeerIds: string[] = [];
    for (const other of this.clients.values()) {
      if (other.record.peerId === client.record.peerId) continue;
      const otherNodeId = other.manifest?.nodeId ?? other.record.nodeId;
      if (otherNodeId !== undefined && remoteNodeIds.has(otherNodeId)) {
        linkedPeerIds.push(other.record.peerId);
      }
    }
    return { ...base, linkedPeerIds };
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
      throw new PeerEndpointError(400, "Cannot pair this server with itself");
  }

  async introducePeer(rawInput: unknown): Promise<c.RemotePeerIntroduceResult> {
    const parsed = c.remotePeerIntroduceParamsSchema.safeParse(rawInput);
    if (!parsed.success) throw new PeerEndpointError(400, "Invalid peer introduction parameters");
    const input = parsed.data;
    let conn: ReturnType<typeof parseConnectionLink>;
    try {
      conn = parseConnectionLink(
        { origin: input.origin, token: input.token },
        { allowLoopback: this.allowLoopback },
      );
    } catch (error) {
      // The connection parser uses fixed messages that do not include the supplied URL or token.
      throw new PeerEndpointError(
        400,
        error instanceof Error ? error.message : "Invalid peer connection",
      );
    }
    await this.check(conn.origin);
    const now = new Date().toISOString();
    const record: PeerRecord = {
      peerId: randomUUID(),
      name: input.name ?? new URL(conn.origin).hostname.slice(0, 120),
      color: input.color,
      origin: conn.origin,
      token: conn.token,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    const candidate = this.createClient(record);
    try {
      try {
        await candidate.probe();
      } catch (error) {
        if (error instanceof Error && error.message === "Cannot pair this server with itself") {
          throw new PeerEndpointError(400, error.message);
        }
        throw new PeerEndpointError(422, "Could not verify the introduced peer connection");
      }
      const manifest = candidate.manifest;
      const nodeId = manifest?.nodeId;
      if (input.expectedNodeId !== undefined && nodeId !== input.expectedNodeId) {
        throw new PeerEndpointError(409, "Introduced peer did not match the expected nodeId");
      }
      const clients = [...this.clients.values()];
      const existing =
        (nodeId === undefined
          ? undefined
          : clients.find(
              (client) =>
                (client.manifest ? client.manifest.nodeId : client.record.nodeId) === nodeId,
            )) ?? clients.find((client) => URL.parse(client.record.origin)?.origin === conn.origin);
      const old = existing?.record;
      const result = {
        peerId: old?.peerId ?? record.peerId,
        hostId: c.remotePeerHostId(old?.peerId ?? record.peerId),
        ...(nodeId === undefined ? {} : { nodeId }),
      };
      if (existing && old?.enabled && old.origin === conn.origin && old.token === conn.token) {
        // Keep the running client, but publish a freshly verified identity if it was not known.
        if (manifest && existing.manifest?.nodeId !== nodeId) {
          existing.manifest = manifest;
          this.changed(existing.hostId);
        }
        return { status: "existing", ...result };
      }
      candidate.record = old
        ? { ...old, origin: conn.origin, token: conn.token, enabled: true, updatedAt: now, nodeId }
        : {
            ...record,
            name: input.name ?? (manifest?.hostname.trim().slice(0, 120) || record.name),
            nodeId,
          };
      const records = this.records();
      this.store.save(
        old
          ? records.map((r) => (r.peerId === old.peerId ? candidate.record : r))
          : [...records, candidate.record],
      );
      this.install(candidate.record, candidate);
      this.changed(candidate.hostId);
      return { status: old ? "updated" : "added", ...result };
    } finally {
      if (this.clients.get(candidate.record.peerId) !== candidate) candidate.close();
    }
  }

  private syncMesh(params: c.RemotePeerSyncMeshParams, anchor?: PeerHostClient) {
    const ids = params.peerIds === undefined ? undefined : new Set(params.peerIds);
    return syncPeerMesh({
      targets: [...this.clients.values()].filter(
        (client) =>
          client !== anchor &&
          client.record.enabled &&
          (ids === undefined || ids.has(client.record.peerId)),
      ),
      anchor,
      includeSelf: params.includeSelf !== false,
      includeMesh: params.includeMesh !== false,
      selfOrigin: params.selfOrigin,
      localNodeId: this.localNodeId,
      resolveSelfShare: this.resolveSelfShare,
      peerTokens: () => this.peerTokens(),
      changed: (client) => {
        if (this.clients.get(client.record.peerId) === client) this.changed(client.hostId);
      },
    });
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
        ...(p.manifest?.nodeId !== undefined ? { nodeId: p.manifest.nodeId } : {}),
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

  /** Browser-safe reachable delegation hosts from the perspective of `sessionHostId` (Hub A hostId space). */
  delegationRemoteHosts(
    sessionHostId = "local",
    localHost?: { hostname?: string; delegationAvailable?: boolean },
  ): c.DelegationRemoteHostOption[] {
    if (sessionHostId === "local") {
      return [...this.clients.values()]
        .filter(
          (p) =>
            p.record.enabled &&
            p.state === "connected" &&
            p.manifest?.capabilities?.delegation === 1,
        )
        .map((p) => ({
          hostId: c.remotePeerHostId(p.record.peerId),
          name: p.record.name,
          ...(p.record.color !== undefined ? { color: p.record.color } : {}),
          ...(p.manifest?.hostname ? { hostname: p.manifest.hostname } : {}),
        }));
    }
    if (c.peerIdFromRemoteHostId(sessionHostId) === undefined) return [];
    const sourceClient = this.client(sessionHostId);
    if (!sourceClient || !sourceClient.record.enabled || sourceClient.state !== "connected") {
      return [];
    }
    const peerNodes = sourceClient.manifest?.peerNodes;
    if (!peerNodes) return [];
    const reachableNodeIds = new Set<string>();
    for (const [peerHostId, nodeId] of Object.entries(peerNodes)) {
      if (c.peerIdFromRemoteHostId(peerHostId) !== undefined && nodeId) {
        reachableNodeIds.add(nodeId);
      }
    }
    const results: c.DelegationRemoteHostOption[] = [];
    if (
      this.localNodeId !== undefined &&
      reachableNodeIds.has(this.localNodeId) &&
      localHost?.delegationAvailable !== false
    ) {
      const localName = localHost?.hostname?.trim() || "local";
      results.push({
        hostId: "local",
        name: localName,
        isLocal: true,
        ...(localHost?.hostname ? { hostname: localHost.hostname } : {}),
      });
    }
    const seenNodeIds = new Set<string>();
    if (sourceClient.manifest?.nodeId) seenNodeIds.add(sourceClient.manifest.nodeId);
    if (this.localNodeId) seenNodeIds.add(this.localNodeId);
    for (const p of this.clients.values()) {
      if (
        !p.record.enabled ||
        p.state !== "connected" ||
        p.hostId === sessionHostId ||
        p.manifest?.capabilities?.delegation !== 1
      ) {
        continue;
      }
      const nodeId = p.manifest?.nodeId;
      if (!nodeId || !reachableNodeIds.has(nodeId) || seenNodeIds.has(nodeId)) continue;
      seenNodeIds.add(nodeId);
      results.push({
        hostId: c.remotePeerHostId(p.record.peerId),
        name: p.record.name,
        ...(p.record.color !== undefined ? { color: p.record.color } : {}),
        ...(p.manifest?.hostname ? { hostname: p.manifest.hostname } : {}),
      });
    }
    return results;
  }

  /** Ready Harness options for a delegation target host (`local` or a connected `remote-peer:*`). */
  async delegationHostHarnesses(
    hostId: string,
    localHarnesses?: () => Promise<c.DelegationHostHarnessOption[]>,
  ): Promise<c.DelegationHostHarnessOption[]> {
    if (hostId === "local") {
      return localHarnesses ? await localHarnesses() : [];
    }
    const client = this.client(hostId);
    if (!client || !client.record.enabled || client.state !== "connected") return [];
    const source = this.source(hostId);
    if (!source) return [];
    const catalog = await source.catalog.models().catch(() => undefined);
    if (!catalog) return [];
    return catalog.groups.map((group) => ({ id: group.id, name: group.name }));
  }

  call(op: c.RemoteSessionOperation) {
    if (op.kind === "hosts") return Promise.resolve(this.hosts());
    return this.get(c.peerIdFromRemoteHostId(op.hostId) ?? "").call(op);
  }

  register(rpc: RpcRegistry, options: PeerHostRegisterOptions = {}) {
    rpc.register(c.DELEGATION_REMOTE_HOSTS_METHOD, async (args, ctx) => {
      if (!ctx.auth) throw new RpcError("auth/required", "Authentication required");
      const { sessionHostId } = c.delegationRemoteHostsParamsSchema.parse(requestOf(args));
      return c.delegationRemoteHostsResultSchema.parse({
        hosts: this.delegationRemoteHosts(sessionHostId ?? "local", {
          ...(options.localHostname === undefined ? {} : { hostname: options.localHostname }),
          ...(options.localDelegationAvailable === undefined
            ? {}
            : { delegationAvailable: options.localDelegationAvailable() }),
        }),
      });
    });
    rpc.register(c.DELEGATION_HOST_HARNESSES_METHOD, async (args, ctx) => {
      if (!ctx.auth) throw new RpcError("auth/required", "Authentication required");
      const { hostId } = c.delegationHostHarnessesParamsSchema.parse(requestOf(args));
      return c.delegationHostHarnessesResultSchema.parse({
        harnesses: await this.delegationHostHarnesses(hostId, options.localHarnesses),
      });
    });
    const linkOptions = { allowLoopback: this.allowLoopback };
    const localOnlyActions = new Set(["add", "update", "remove", "test", "syncMesh"]);
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
        if (action === "list")
          return { peers: [...this.clients.values()].map((p) => this.summarize(p)) };
        if (action === "syncMesh")
          return this.syncMesh(c.remotePeerSyncMeshParamsSchema.parse(input));
        if (action === "add" || action === "test") {
          const add = action === "add" ? c.remotePeerAddParamsSchema.parse(input) : undefined;
          const p = add ?? c.remotePeerTestParamsSchema.parse(input);
          const conn = parseConnectionLink(
            "peerId" in p && p.peerId ? this.get(p.peerId).record : p,
            linkOptions,
          );
          await this.check(conn.origin);
          const now = new Date().toISOString();
          const record: PeerRecord = {
            peerId: randomUUID(),
            name: add?.name ?? new URL(conn.origin).hostname.slice(0, 120),
            color: add?.color,
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
            client.close();
            if (!add) return { ok: false, error: e instanceof Error ? e.message : "Probe failed" };
            throw e;
          }
          if (!add) {
            client.close();
            return c.remotePeerTestResultSchema.parse({
              ...client.summary(),
              projects: client.manifest?.projects.map(({ id, name, path }) => ({
                id,
                name,
                path,
              })),
              ok: true,
            });
          }
          record.name = add.name ?? (client.manifest?.hostname.trim().slice(0, 120) || record.name);
          record.nodeId = client.manifest?.nodeId;
          try {
            this.store.save([...this.records(), record]);
          } catch (error) {
            client.close();
            throw error;
          }
          const installed = this.install(record, client);
          this.changed(installed.hostId);
          if (add.pairBack === true || add.meshPeerIds?.length) {
            const pairing = await this.syncMesh(
              {
                peerIds: add.meshPeerIds ?? [],
                includeSelf: add.pairBack === true,
                selfOrigin: add.selfOrigin,
              },
              installed,
            );
            return { peer: this.summarize(installed), pairing };
          }
          return { peer: this.summarize(installed) };
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
              nodeId:
                conn.origin === old.origin
                  ? client.manifest
                    ? client.manifest.nodeId
                    : old.nodeId
                  : undefined,
              enabled: p.enabled ?? old.enabled,
              name: p.name ?? old.name,
              updatedAt: new Date().toISOString(),
            };
            if (nextColor !== undefined) {
              record.color = nextColor;
            } else {
              delete record.color;
            }
            let probedClient: PeerHostClient | undefined;
            if (
              this.localNodeId !== undefined &&
              record.enabled &&
              (conn.origin !== old.origin || conn.token !== old.token || !old.enabled)
            ) {
              const candidate = this.createClient(record);
              try {
                await candidate.probe();
                record.nodeId = candidate.manifest?.nodeId;
                probedClient = candidate;
              } catch (e) {
                candidate.close();
                if (e instanceof Error && e.message === "Cannot pair this server with itself") {
                  throw e;
                }
              }
              if (this.clients.get(peerId) !== client) {
                probedClient?.close();
                throw Error("Peer changed");
              }
            }
            this.store.save(this.records().map((r) => (r.peerId === peerId ? record : r)));
            if (
              record.enabled === old.enabled &&
              record.origin === old.origin &&
              record.token === old.token
            ) {
              client.record = record;
              this.changed(client.hostId);
              return { peer: this.summarize(client) };
            }
            const next = this.install(record, probedClient);
            this.changed(next.hostId);
            return { peer: this.summarize(next) };
          }
          case "reconnect": {
            const next = this.install(client.record);
            this.changed(next.hostId);
            return { peer: this.summarize(next) };
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
