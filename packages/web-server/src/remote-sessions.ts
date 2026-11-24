import type { IncomingMessage, ServerResponse } from "node:http";
import {
  loadCatalog,
  RemoteProjectDraft,
  type RemoteDraftCatalog,
} from "./remote-project-draft.ts";
import { remoteApprovalPresentation } from "./remote-approval.ts";
import { requestRemoteSession, RemoteSessionError } from "@codexhost/desktop-control";
import { z } from "zod";
import {
  harnessConfigurationStateSchema,
  REMOTE_PEER_HOST_ID_PREFIX,
  remotePeerPromptParamsSchema,
  remoteQueueSnapshotSchema,
  remoteSessionOperationSchema,
  remoteSessionRequestBytes,
  threadInspectionSchema,
  threadUsageInspectionSchema,
  REMOTE_CONTROLLER_REQUEST_MAX_BYTES,
  REMOTE_IDENTITY_MAX_LENGTH,
  WEB_FOLLOW_PROJECTION_KEYS,
  webToolOutputReferenceSchema,
  type RemotePeerPromptParams,
  type RemoteSessionOperation,
} from "@codexhost/shared-contracts";
import { ChThreadHistory } from "./ch-thread-history.ts";
import { threadListTitle } from "./ch-thread-title.ts";
import { tryGenerateThreadTitle } from "./ch-thread-titles.ts";
import { ChThreadView, type ChThread } from "./ch-thread-view.ts";
import { isMethodUnavailableError, type PeerThreadSource } from "./peer-thread-source.ts";
import { RemotePeerAttachments, type PeerAttachmentEndpoint } from "./remote-peer-attachments.ts";
import type { WebFileRef } from "./web-files.ts";
import { WEB_IMAGE_LIMITS } from "./web-images.ts";
import { defaultProjections } from "./session-log.ts";
import {
  applyRemoteControls,
  executeRemoteCommand,
  modelConfiguration,
  mergeRemoteControls,
  parseRemoteControls,
  remoteHarnessIdentity,
  remoteModelCatalog,
  selectRemoteModel,
  viewHarnessId,
  type RemoteConfigurationSetting,
  type RemoteControls,
} from "./remote-session-controls.ts";
import {
  readRemoteHistory,
  remoteThreadRowSchema as rowSchema,
  type RemotePendingRequest as PendingRequest,
} from "./remote-session-history.ts";
import {
  deliverRemoteInput,
  readRemoteThreadStatus,
  remoteOutcomeUnknown,
  remotePromptText,
  type RemoteSessionCall,
} from "./remote-session-delivery.ts";
import { requestOf } from "./store.ts";
import {
  RpcError,
  type EventHub,
  type RpcRegistry,
  type StreamRegistry,
  type StreamSink,
} from "./transport.ts";
import { readToolOutput, toolOutputSink } from "./tool-output.ts";
import { followRemoteHistory } from "./remote-history-follow.ts";
import type { Workspaces } from "./workspaces.ts";
import { applyUsageProjections } from "./usage-projection.ts";
import {
  remoteWorkspaceGroups,
  remoteWorkspaceId,
  remoteHostDisplayName,
  type RemoteWorkspaceHost,
} from "./remote-workspaces.ts";

const PREFIX = "web-remote:";
const hostsSchema = z.array(
  z.object({
    hostId: z.string().min(1),
    online: z.boolean(),
    epoch: z.string().min(1).optional(),
    displayName: z.string().optional(),
    state: z.string().optional(),
    projects: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          path: z.string(),
          threadIds: z.array(z.string()),
        }),
      )
      .optional(),
  }),
);
const pageSchema = z.object({
  data: z.array(rowSchema),
  nextCursor: z.string().nullable(),
  loaded: z.array(z.string()).optional(),
  epoch: z.string().optional(),
});
export function remoteSessionId(hostId: string, threadId: string): string {
  return PREFIX + Buffer.from(JSON.stringify([hostId, threadId])).toString("base64url");
}
export function remoteSessionIdentity(
  id: string,
): { hostId: string; threadId: string } | undefined {
  if (!id.startsWith(PREFIX)) return;
  try {
    const value: unknown = JSON.parse(Buffer.from(id.slice(PREFIX.length), "base64url").toString());
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      value.every((item) => typeof item === "string" && item) &&
      value[0] !== "local" &&
      value[0] !== "durable" &&
      remoteSessionId(value[0], value[1]) === id
    )
      return { hostId: value[0], threadId: value[1] };
  } catch {
    /* Reserved malformed identities never fall through to the local owner. */
  }
  throw new RpcError("remote/identity-invalid", "Invalid remote Thread identity");
}
const PROXY_NOT_FOUND_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
} as const;

function hasContentPartType(content: unknown, type: string): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (part) =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === type,
    )
  );
}

function hasNonTextContentPart(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (part) =>
        typeof part !== "object" || part === null || (part as { type?: unknown }).type !== "text",
    )
  );
}

export interface RemotePeerProvider {
  source(hostId: string): PeerThreadSource | undefined;
  client?(hostId: string): PeerAttachmentEndpoint | undefined;
  onThreadChanged?: (hostId: string, threadId: string) => unknown;
  onUsageChanged?: (hostId: string, threadId: string) => void;
  onCatalogInspectionChanged?: (hostId: string) => void;
  onConnection?: (hostId: string, online: boolean) => void;
  onReset?: (hostId: string, epoch: string, full: boolean) => void;
}

interface Entry {
  identity: { hostId: string; threadId: string };
  row: ChThread;
  online: boolean;
  archived?: boolean;
  epoch?: string;
  /** A new native Thread can be loaded before it appears in the persisted catalog. */
  createdEpoch?: string;
  /** Retained after draft creation succeeds but first prompt fails so retries keep binding the scope. */
  pendingUploadScope?: string;
  fullReadAt?: number;
  configurationRevision: number;
  view?: ChThreadView;
  viewHarnessId?: string;
  viewOrigin?: number;
  reading?: Promise<ChThreadView>;
  queueReading?: Promise<void>;
  controls?: RemoteControls;
  peerHarnessIdentity?: { id: string; name: string };
  peerOwnershipAvailable?: boolean;
  peerTreeParent?: string | null;
  peerInspected?: { view: ChThreadView; epoch: string; revision: number };
  historyError?: { code: string; message: string };
  usageRequest?: {
    view: ChThreadView;
    updatedAt: number;
    lastTurnId: string | undefined;
    retryAt: number;
    pending: boolean;
    dirty?: boolean;
  };
}

/** Separate remote ownership facade. Local ChSessions and native shared-backend discovery
 * retain their own lifecycle; remote cwd and attachment paths never reach local tools. */
export class RemoteSessions {
  private drafts = new Map<string, RemoteProjectDraft>();
  private pendingFirstTurns = new Map<string, RemoteProjectDraft>();
  private readonly titleRequests = new Set<string>();
  private entries = new Map<string, Entry>();
  private hosts = new Map<string, RemoteWorkspaceHost>();
  private peerArchivedIds = new Map<string, Set<string>>();
  private controls = new Set<StreamSink>();
  private pending = new Map<string, { sessionId: string; cancel(): void }>();
  private readonly followLifetime = new AbortController();
  private listing: Promise<void> | undefined;
  private archiveRevision = 0;
  private archiveWrites = 0;
  private discoveryUnavailable = false;
  private closed = false;
  private readonly timer: NodeJS.Timeout;
  private readonly peerHandlers: {
    onThreadChanged: (hostId: string, threadId: string) => Promise<void>;
    onUsageChanged: (hostId: string, threadId: string) => void;
    onCatalogInspectionChanged: (hostId: string) => void;
    onConnection: (hostId: string, online: boolean) => void;
    onReset: (hostId: string, epoch: string, full: boolean) => void;
  };
  private readonly controlProjectionListener = (
    sessionId: string,
    key: string,
    value: unknown,
    seq: number,
  ) => {
    if (WEB_FOLLOW_PROJECTION_KEYS.has(key)) return;
    for (const sink of this.controls) sink.push({ type: "projection", sessionId, key, value, seq });
  };
  constructor(
    private readonly events: EventHub,
    private readonly call: RemoteSessionCall = requestRemoteSession,
    private readonly workspaces?: Workspaces,
    private readonly peers?: RemotePeerProvider,
    private readonly attachments: RemotePeerAttachments = new RemotePeerAttachments(),
  ) {
    this.peerHandlers = {
      onThreadChanged: (hostId, threadId) => this.handlePeerThreadChanged(hostId, threadId),
      onUsageChanged: (hostId, threadId) => this.handlePeerUsageChanged(hostId, threadId),
      onCatalogInspectionChanged: (hostId) => this.handlePeerCatalogInspectionChanged(hostId),
      onConnection: (hostId, online) => this.handlePeerConnection(hostId, online),
      onReset: (hostId, epoch) => this.handlePeerReset(hostId, epoch),
    };
    if (peers) {
      peers.onThreadChanged ??= this.peerHandlers.onThreadChanged;
      peers.onUsageChanged ??= this.peerHandlers.onUsageChanged;
      peers.onCatalogInspectionChanged ??= this.peerHandlers.onCatalogInspectionChanged;
      peers.onConnection ??= this.peerHandlers.onConnection;
      peers.onReset ??= this.peerHandlers.onReset;
    }
    this.timer = setInterval(() => {
      if (this.controls.size) void this.refresh().catch(() => undefined);
    }, 30_000);
    this.timer.unref();
  }
  private async handlePeerThreadChanged(hostId: string, threadId: string): Promise<void> {
    if (this.closed) return;
    const id = remoteSessionId(hostId, threadId);
    if (!this.entries.has(id)) return;
    try {
      await this.read(id, true);
    } catch (error) {
      if (
        error instanceof RpcError &&
        ["remote/not-found", "remote/identity-invalid", "remote/offline"].includes(error.code)
      ) {
        return;
      }
      throw error;
    }
  }
  private handlePeerUsageChanged(hostId: string, threadId: string): void {
    if (this.closed) return;
    const id = remoteSessionId(hostId, threadId);
    const entry = this.entries.get(id);
    if (!entry || !entry.online || !entry.view || !entry.epoch) return;
    if (entry.usageRequest?.view === entry.view && entry.usageRequest.pending) {
      entry.usageRequest.dirty = true;
      return;
    }
    this.loadUsage(id, entry, entry.view, entry.epoch, true);
  }
  private handlePeerCatalogInspectionChanged(hostId: string): void {
    if (this.closed) return;
    for (const draft of this.drafts.values()) {
      if (draft.target.hostId === hostId) draft.invalidateCatalog();
    }
    for (const entry of this.entries.values()) {
      if (entry.identity.hostId !== hostId) continue;
      delete entry.peerInspected;
      if (entry.controls) delete entry.controls.inspection;
    }
  }
  private handlePeerConnection(hostId: string, online: boolean): void {
    if (this.closed || online) return;
    const host = this.hosts.get(hostId);
    if (host) host.online = false;
    for (const entry of this.entries.values()) {
      if (entry.identity.hostId === hostId) this.offline(entry);
    }
    this.syncGroups();
  }
  private handlePeerReset(hostId: string, epoch: string): void {
    if (this.closed) return;
    for (const [id, entry] of this.entries) {
      if (entry.identity.hostId !== hostId) continue;
      if (entry.epoch && entry.epoch !== epoch) {
        this.clearPending(id);
        this.retireView(entry);
        delete entry.controls;
        delete entry.peerInspected;
        entry.epoch = epoch;
      }
    }
  }
  private peerEndpoint(hostId: string): PeerAttachmentEndpoint | undefined {
    if (!hostId.startsWith(REMOTE_PEER_HOST_ID_PREFIX)) return undefined;
    return this.peers?.client?.(hostId);
  }
  private peerAttachmentsSupported(hostId: string): boolean {
    return this.attachments.supported(this.peerEndpoint(hostId));
  }
  private draftSummary(draft: RemoteProjectDraft) {
    return draft.summary(this.peerAttachmentsSupported(draft.target.hostId));
  }
  async uploadFile(
    id: string,
    chunks: AsyncIterable<Uint8Array>,
    name?: string,
    imageMediaType?: string,
  ): Promise<{ receiptId: string; file: WebFileRef }> {
    if (this.closed) throw new RpcError("remote/offline", "Remote session gateway is closed");
    const draft = this.drafts.get(id);
    if (draft) {
      draft.lastUsed = Date.now();
      if (!draft.canonicalId) {
        const peer = this.peerEndpoint(draft.target.hostId);
        if (!this.attachments.supported(peer)) {
          throw new RpcError(
            "remote/attachments-unsupported",
            "Remote peer does not support attachments.",
          );
        }
        const scope = draft.ensureUploadScope();
        return this.attachments.upload(peer, { scope }, chunks, name, imageMediaType);
      }
      id = draft.canonicalId;
    }
    const identity = remoteSessionIdentity(id);
    if (!identity) throw new RpcError("remote/identity-invalid", "Invalid remote Thread identity");
    const peer = this.peerEndpoint(identity.hostId);
    if (!this.attachments.supported(peer)) {
      throw new RpcError(
        "remote/attachments-unsupported",
        "Remote peer does not support attachments.",
      );
    }
    return this.attachments.upload(
      peer,
      { threadId: identity.threadId },
      chunks,
      name,
      imageMediaType,
    );
  }
  async servePeerFile(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const isHead = request.method === "HEAD";
    if (request.method !== "GET" && !isHead) {
      response
        .writeHead(405, PROXY_NOT_FOUND_HEADERS)
        .end(isHead ? undefined : "method not allowed");
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const rawSessionId = url.searchParams.get("sessionId");
    const path = url.searchParams.get("path");
    if (!rawSessionId || !rawSessionId.startsWith(PREFIX)) {
      response
        .writeHead(404, PROXY_NOT_FOUND_HEADERS)
        .end(isHead ? undefined : "image unavailable");
      return;
    }
    const draft = this.drafts.get(rawSessionId);
    const targetId = draft ? draft.canonicalId : rawSessionId;
    if (!targetId) {
      response
        .writeHead(404, PROXY_NOT_FOUND_HEADERS)
        .end(isHead ? undefined : "image unavailable");
      return;
    }
    let identity: { hostId: string; threadId: string } | undefined;
    try {
      identity = remoteSessionIdentity(targetId);
    } catch {
      identity = undefined;
    }
    if (!identity || !identity.hostId.startsWith(REMOTE_PEER_HOST_ID_PREFIX)) {
      response
        .writeHead(404, PROXY_NOT_FOUND_HEADERS)
        .end(isHead ? undefined : "image unavailable");
      return;
    }
    const peer = this.peerEndpoint(identity.hostId);
    if (!peer || !this.attachments.supported(peer)) {
      response
        .writeHead(404, PROXY_NOT_FOUND_HEADERS)
        .end(isHead ? undefined : "image unavailable");
      return;
    }
    await this.attachments.serveFile(peer, identity.threadId, path ?? "", request, response);
  }
  private draftCatalogLoader(draft: RemoteProjectDraft): () => Promise<RemoteDraftCatalog> {
    const peerSource = this.peers?.source(draft.target.hostId);
    if (peerSource) return () => peerSource.catalog.models();
    return () => loadCatalog(draft.target, (op) => this.invoke(op));
  }
  private async invoke(
    operation: RemoteSessionOperation,
    onDispatch?: () => void,
  ): Promise<unknown> {
    if (this.closed) throw new RpcError("remote/offline", "Remote session gateway is closed");
    const parsed = remoteSessionOperationSchema.safeParse(operation);
    if (!parsed.success) {
      const tooLarge = parsed.error.issues.some((issue) => issue.code === "too_big");
      throw new RpcError(
        tooLarge ? "remote/too-large" : "remote/invalid-request",
        tooLarge
          ? "Remote request is too large; shorten the message before sending."
          : "Invalid remote request; check the message and try again.",
      );
    }
    if (remoteSessionRequestBytes(parsed.data) > REMOTE_CONTROLLER_REQUEST_MAX_BYTES)
      throw new RpcError(
        "remote/too-large",
        "Remote request is too large; shorten the message before sending.",
      );
    onDispatch?.();
    try {
      return await this.call(parsed.data);
    } catch (error) {
      if (
        "hostId" in operation &&
        operation.hostId.startsWith("remote-peer:") &&
        error instanceof RpcError
      )
        throw error;
      const write = ![
        "hosts",
        "list",
        "read",
        "status",
        "usage",
        "queue",
        "projectHarnesses",
        "inspectHarness",
      ].includes(operation.kind);
      if (error instanceof RemoteSessionError && error.code === -32096)
        throw new RpcError("remote/controller-rejected", error.message);
      if (!write && error instanceof RemoteSessionError && ![-32090, -32093].includes(error.code))
        throw new RpcError(
          error.code === -32094
            ? "remote/history-too-large"
            : error.code === -32095
              ? "remote/connection-changed"
              : "remote/read-failed",
          error.message,
        );
      if (write) throw remoteOutcomeUnknown();
      if ("hostId" in operation && operation.hostId.startsWith("remote-peer:"))
        throw new RpcError("remote/read-failed", "Remote peer did not return a valid response.");
      throw new RpcError(
        "remote/offline",
        "Desktop remote connection is unavailable. Reconnect in Codex Desktop and refresh. If Desktop cannot be discovered, configure CODEXHOST_DESKTOP_RUNTIME_DESCRIPTOR with its private descriptor path.",
      );
    }
  }
  private refreshPending = false;
  private fullRefreshPending = false;
  private pendingHostIds = new Set<string>();
  private hasPendingRefresh(): boolean {
    return this.refreshPending || this.fullRefreshPending || this.pendingHostIds.size > 0;
  }
  private startRefresh(): Promise<void> {
    this.listing ??= this.list().finally(() => {
      this.listing = undefined;
      if (!this.closed && !this.archiveWrites && this.hasPendingRefresh()) {
        this.refreshPending = false;
        void this.startRefresh().catch(() => undefined);
      }
    });
    return this.listing;
  }
  hostsChanged(hostId?: string): void {
    if (this.closed) return;
    if (hostId) this.pendingHostIds.add(hostId);
    else this.fullRefreshPending = true;
    if (this.listing || this.archiveWrites) {
      this.refreshPending = true;
      return;
    }
    void this.startRefresh().catch(() => undefined);
  }
  refresh(hostId?: string): Promise<void> {
    if (hostId) this.pendingHostIds.add(hostId);
    else this.fullRefreshPending = true;
    if (this.archiveWrites) {
      this.refreshPending = true;
      return this.listing ?? Promise.resolve();
    }
    return this.startRefresh();
  }
  private async list(): Promise<void> {
    if (this.archiveWrites) return;
    const fullRefresh = this.fullRefreshPending || this.pendingHostIds.size === 0;
    const dirtyHosts = new Set(this.pendingHostIds);
    this.fullRefreshPending = false;
    this.pendingHostIds.clear();
    const previouslyOnline = new Set(
      [...this.hosts.values()].filter((host) => host.online).map((host) => host.hostId),
    );
    const archiveRevision = this.archiveRevision;
    let hosts: RemoteWorkspaceHost[];
    try {
      hosts = hostsSchema.parse(await this.invoke({ kind: "hosts" }));
      this.discoveryUnavailable = false;
    } catch {
      if (!this.discoveryUnavailable)
        console.warn(
          "[remote-sessions] Desktop discovery unavailable. Start codexhost Desktop; if Web uses a different environment, set CODEXHOST_DESKTOP_RUNTIME_DESCRIPTOR to its private desktop-runtime-v1.json path.",
        );
      this.discoveryUnavailable = true;
      for (const entry of this.entries.values()) this.offline(entry);
      for (const host of this.hosts.values()) host.online = false;
      this.syncGroups();
      return;
    }
    this.hosts = new Map(hosts.map((host) => [host.hostId, host]));
    for (const [id, entry] of this.entries) {
      if (
        entry.identity.hostId.startsWith("remote-peer:") &&
        !this.hosts.has(entry.identity.hostId)
      ) {
        this.clearPending(id);
        this.retireView(entry);
        this.entries.delete(id);
        this.events.emit("api-session/removed", id);
      }
    }
    for (const [id, draft] of this.drafts) {
      if (draft.target.hostId.startsWith("remote-peer:") && !this.hosts.has(draft.target.hostId)) {
        this.drafts.delete(id);
        if (!draft.canonicalId) this.events.emit("api-session/removed", id);
      }
    }
    for (const hostId of [...this.peerArchivedIds.keys()]) {
      if (!this.hosts.has(hostId)) this.peerArchivedIds.delete(hostId);
    }
    const present = new Set(hosts.filter((host) => host.online).map((host) => host.hostId));
    for (const entry of this.entries.values())
      if (!present.has(entry.identity.hostId)) this.offline(entry);
    await Promise.all(
      hosts
        .filter(
          (host) =>
            host.online &&
            (fullRefresh || dirtyHosts.has(host.hostId) || !previouslyOnline.has(host.hostId)),
        )
        .map(async (host) => {
          const peerSource = this.peers?.source(host.hostId);
          if (peerSource) {
            await this.listPeerHost(host, peerSource, archiveRevision);
            this.syncGroups();
            return;
          }
          const found = new Map<string, Entry>();
          const unlisted = new Set(
            [...this.entries.values()].filter(
              (entry) => entry.identity.hostId === host.hostId && entry.createdEpoch,
            ),
          );
          let loaded: Set<string> | undefined;
          let loadedEpoch: string | undefined;
          try {
            let cursor: string | null = null;
            const seen = new Set<string>();
            do {
              const page = pageSchema.parse(
                await this.invoke({
                  kind: "list",
                  hostId: host.hostId,
                  cursor,
                  archived: false,
                  ...(cursor === null && unlisted.size ? { includeLoaded: true } : {}),
                }),
              );
              if (page.loaded) {
                loaded = new Set(page.loaded);
                loadedEpoch = page.epoch;
              }
              for (const row of page.data) {
                const id = remoteSessionId(host.hostId, row.id);
                found.set(id, {
                  identity: { hostId: host.hostId, threadId: row.id },
                  row: { ...row, turns: [] } as ChThread,
                  online: true,
                  configurationRevision: 0,
                });
              }
              cursor = page.nextCursor;
              if (cursor && seen.has(cursor)) throw new Error("Remote cursor did not advance");
              if (cursor) seen.add(cursor);
            } while (cursor && seen.size < 100);
            if (cursor) throw new Error("Remote catalog exceeds bounded traversal");
            if (this.closed || archiveRevision !== this.archiveRevision) return;
            for (const [id, entry] of this.entries)
              if (entry.identity.hostId === host.hostId && !found.has(id) && !entry.archived) {
                if (
                  entry.createdEpoch &&
                  (!unlisted.has(entry) ||
                    (entry.createdEpoch === loadedEpoch && loaded?.has(entry.identity.threadId)))
                ) {
                  if (!entry.online && entry.createdEpoch === loadedEpoch) {
                    entry.online = true;
                    this.events.emit("api-session/added", this.summary(id, entry));
                  }
                  continue;
                }
                this.entries.delete(id);
                this.clearPending(id);
                entry.view?.log.reconnectFollowers();
                this.events.emit("api-session/removed", id);
              }
            for (const [id, entry] of found) {
              const previous = this.entries.get(id);
              const changed =
                !previous ||
                !previous.online ||
                JSON.stringify(previous.row) !== JSON.stringify(entry.row);
              const current = previous
                ? Object.assign(previous, { row: entry.row, online: true, archived: false })
                : entry;
              this.entries.set(id, current);
              delete current.createdEpoch;
              if (changed) this.events.emit("api-session/added", this.summary(id, current));
            }
            this.syncArchives();
          } catch {
            host.online = false;
            for (const entry of this.entries.values())
              if (entry.identity.hostId === host.hostId) this.offline(entry);
          }
          this.syncGroups();
        }),
    );
    this.syncGroups();
  }
  private async listPeerHost(
    host: RemoteWorkspaceHost,
    source: PeerThreadSource,
    archiveRevision: number,
  ): Promise<void> {
    const unlisted = new Set(
      [...this.entries.values()].filter(
        (entry) => entry.identity.hostId === host.hostId && entry.createdEpoch,
      ),
    );
    try {
      const listed = await source.listThreads();
      const uniqueHarnesses = [...new Set(listed.harnessIds.values())];
      const harnessNames = new Map(
        await Promise.all(
          uniqueHarnesses.map(
            async (harnessId) =>
              [harnessId, await source.catalog.name(harnessId).catch(() => harnessId)] as const,
          ),
        ),
      );
      if (this.closed || archiveRevision !== this.archiveRevision) return;
      this.peerArchivedIds.set(host.hostId, new Set(listed.archivedIds));
      const found = new Map<string, Entry>();
      for (const row of listed.rows) {
        const id = remoteSessionId(host.hostId, row.id);
        const harnessId = listed.harnessIds.get(row.id);
        const peerHarnessIdentity = harnessId
          ? { id: harnessId, name: harnessNames.get(harnessId) ?? harnessId }
          : undefined;
        const nativeParent = listed.ownershipAvailable ? (listed.parents[row.id] ?? null) : null;
        const peerTreeParent = listed.ownershipAvailable
          ? nativeParent && nativeParent !== row.id
            ? remoteSessionId(host.hostId, nativeParent)
            : null
          : undefined;
        found.set(id, {
          identity: { hostId: host.hostId, threadId: row.id },
          row: { ...row, turns: [] },
          online: true,
          archived: listed.archivedIds.has(row.id),
          ...(host.epoch ? { epoch: host.epoch } : {}),
          configurationRevision: 0,
          peerOwnershipAvailable: listed.ownershipAvailable,
          ...(peerHarnessIdentity ? { peerHarnessIdentity } : {}),
          ...(peerTreeParent !== undefined ? { peerTreeParent } : {}),
        });
      }
      for (const [id, entry] of this.entries) {
        if (entry.identity.hostId === host.hostId && !found.has(id) && !entry.archived) {
          if (
            entry.createdEpoch &&
            !listed.archivedIds.has(entry.identity.threadId) &&
            (!unlisted.has(entry) || entry.createdEpoch === host.epoch)
          ) {
            if (!entry.online && entry.createdEpoch === host.epoch) {
              entry.online = true;
              this.events.emit("api-session/added", this.summary(id, entry));
            }
            continue;
          }
          this.entries.delete(id);
          this.clearPending(id);
          source.discard(entry.identity.threadId);
          entry.view?.log.reconnectFollowers();
          this.events.emit("api-session/removed", id);
        }
      }
      for (const [id, entry] of found) {
        const previous = this.entries.get(id);
        const beforeSummary = previous ? JSON.stringify(this.summary(id, previous)) : undefined;
        if (previous && host.epoch && previous.epoch && previous.epoch !== host.epoch) {
          this.clearPending(id);
          this.retireView(previous, source);
          delete previous.controls;
          delete previous.peerInspected;
        }
        const current = previous
          ? Object.assign(previous, {
              row: entry.row,
              online: true,
              archived: entry.archived ?? false,
              peerOwnershipAvailable: entry.peerOwnershipAvailable,
              ...(host.epoch ? { epoch: host.epoch } : {}),
            })
          : entry;
        if (entry.peerHarnessIdentity) {
          current.peerHarnessIdentity = entry.peerHarnessIdentity;
        } else if (entry.peerOwnershipAvailable) {
          delete current.peerHarnessIdentity;
        }
        if (entry.peerTreeParent !== undefined) {
          current.peerTreeParent = entry.peerTreeParent;
        } else {
          delete current.peerTreeParent;
        }
        this.entries.set(id, current);
        delete current.createdEpoch;
        const nextSummary = this.summary(id, current);
        if (current.view) {
          current.view.log.setProjection("title", nextSummary.projections.values.title);
          current.view.log.setProjection("remoteHost", nextSummary.projections.values.remoteHost);
          current.view.log.setProjection(
            "attachmentInput",
            nextSummary.projections.values.attachmentInput,
          );
          if ("imageLimits" in nextSummary.projections.values) {
            current.view.log.setProjection(
              "imageLimits",
              nextSummary.projections.values.imageLimits,
            );
          }
          if (current.peerOwnershipAvailable && current.peerTreeParent !== undefined) {
            current.view.log.setProjection("threadTreeParent", current.peerTreeParent);
          }
          if (current.peerHarnessIdentity) {
            current.view.log.setProjection("harnessIdentity", current.peerHarnessIdentity);
          }
        }
        if (beforeSummary !== JSON.stringify(nextSummary)) {
          this.events.emit("api-session/added", nextSummary);
        }
      }
      this.syncArchives();
    } catch {
      host.online = false;
      for (const entry of this.entries.values()) {
        if (entry.identity.hostId === host.hostId) this.offline(entry);
      }
    }
  }
  private async projectTarget(workspaceId: string) {
    const hosts = hostsSchema.parse(await this.invoke({ kind: "hosts" }));
    for (const host of hosts) {
      const project = host.projects?.find(
        (p) => remoteWorkspaceId(host.hostId, p.id) === workspaceId,
      );
      if (!project?.path) continue;
      if (!host.online)
        throw new RpcError(
          "remote/offline",
          host.hostId.startsWith("remote-peer:")
            ? "Reconnect this remote peer."
            : "Reconnect this project in Codex Desktop.",
        );
      if (!host.epoch)
        throw new RpcError(
          "remote/unsupported",
          "Update CodexHost Desktop to create remote Threads.",
        );
      return {
        host,
        project,
        target: { hostId: host.hostId, epoch: host.epoch, cwd: project.path },
      };
    }
    throw new RpcError(
      "workspace/not-found",
      "Select a registered remote project in Codex Desktop.",
    );
  }
  private async createInProject(workspaceId: string, previous?: string) {
    const { host, project, target } = await this.projectTarget(workspaceId);
    if (previous) {
      const draft = this.drafts.get(previous);
      if (
        !draft ||
        draft.workspaceId !== workspaceId ||
        draft.submission ||
        draft.target.epoch !== target.epoch ||
        draft.target.cwd !== target.cwd
      )
        throw new RpcError("session/writer-held", "Start a fresh draft in this remote project.");
      draft.lastUsed = Date.now();
      return { sessionId: draft.id, agentPreset: "standard" };
    }
    // Ephemeral aliases also fence repeated first sends. Expired IDs cannot target a native Thread.
    for (const [key, old] of this.drafts) {
      if (Date.now() - old.lastUsed > 24 * 60 * 60 * 1000 && !old.sending) {
        this.drafts.delete(key);
        if (!old.canonicalId) this.events.emit("api-session/removed", key);
      }
    }
    const draft = new RemoteProjectDraft(
      workspaceId,
      project.id,
      target,
      remoteHostDisplayName(host),
    );
    this.drafts.set(draft.id, draft);
    this.hosts.set(host.hostId, host);
    this.syncGroups();
    this.events.emit("api-session/added", this.draftSummary(draft));
    return { sessionId: draft.id, agentPreset: "standard" };
  }
  private async firstTurn(draft: RemoteProjectDraft, request: Record<string, unknown>) {
    const isPeer = draft.target.hostId.startsWith(REMOTE_PEER_HOST_ID_PREFIX);
    if (!isPeer && hasContentPartType(request.content, "file")) {
      throw new RpcError(
        "remote/attachments-unsupported",
        "Remote attachments are not supported for this host.",
      );
    }
    const usePeerAttachments =
      isPeer && (hasNonTextContentPart(request.content) || draft.uploadScope !== undefined);
    let peerPromptContent: RemotePeerPromptParams["content"] | undefined;
    let peerPromptMode: "queue" | undefined;
    let peerPromptRequestId: string | undefined;
    let legacyPrompt:
      | {
          kind: "prompt";
          hostId: string;
          epoch: string;
          text: string;
          requestId?: string;
        }
      | undefined;
    let key: string;
    if (usePeerAttachments) {
      const peer = this.peerEndpoint(draft.target.hostId);
      if (!this.attachments.supported(peer)) {
        throw new RpcError(
          "remote/attachments-unsupported",
          "Remote peer does not support attachments.",
        );
      }
      if (hasContentPartType(request.content, "image")) {
        throw new RpcError(
          "session/attachment-invalid",
          "Encoded image parts are not supported for remote peer sessions.",
          { reason: "REMOTE_ENCODED_IMAGE_UNSUPPORTED" },
        );
      }
      if (request.mode === "steer" || (request.mode !== undefined && request.mode !== "queue")) {
        throw new RpcError("remote/invalid-request", "Send a nonempty message or attach a file.");
      }
      const parsedContent = remotePeerPromptParamsSchema.shape.content.safeParse(request.content);
      if (!parsedContent.success) {
        throw new RpcError("session/attachment-invalid", "Invalid remote peer prompt parameters.");
      }
      const hasFile = parsedContent.data.some((part) => part.type === "file");
      const hasNonEmptyText = parsedContent.data.some(
        (part) => part.type === "text" && part.text.trim().length > 0,
      );
      if (!hasFile && !hasNonEmptyText) {
        throw new RpcError("remote/invalid-request", "Send a nonempty message or attach a file.");
      }
      if (request.requestId !== undefined) {
        const parsedRequestId = remotePeerPromptParamsSchema.shape.requestId.safeParse(
          request.requestId,
        );
        if (!parsedRequestId.success) {
          throw new RpcError(
            "session/attachment-invalid",
            "Invalid remote peer prompt parameters.",
          );
        }
        peerPromptRequestId = parsedRequestId.data;
      }
      peerPromptContent = parsedContent.data;
      peerPromptMode = request.mode;
      key = JSON.stringify([peerPromptRequestId, peerPromptContent]);
    } else {
      const parts = z
        .array(z.object({ type: z.literal("text"), text: z.string() }))
        .safeParse(request.content);
      const text = parts.success ? parts.data.map((p) => p.text).join("\n") : "";
      const prompt = {
        kind: "prompt" as const,
        hostId: draft.target.hostId,
        epoch: draft.target.epoch,
        text,
        ...(typeof request.requestId === "string" ? { requestId: request.requestId } : {}),
      };
      // The ID is assigned only after creation. Each UTF-16 unit can take six JSON bytes.
      const probe = { ...prompt, threadId: "\u0000".repeat(REMOTE_IDENTITY_MAX_LENGTH) };
      if (
        !text.trim() ||
        request.mode === "steer" ||
        !remoteSessionOperationSchema.safeParse(probe).success ||
        remoteSessionRequestBytes(probe) > REMOTE_CONTROLLER_REQUEST_MAX_BYTES
      )
        throw new RpcError(
          "remote/invalid-request",
          "Send a nonempty text message within the remote size limit.",
        );
      legacyPrompt = prompt;
      key = JSON.stringify([request.requestId, text]);
    }
    if (draft.submission) {
      if (draft.submission.key === key) return draft.submission.result;
      throw new RpcError("session/busy", "The first message was already submitted.");
    }
    let dispatched = false;
    const result = (async () => {
      const operation = await draft.startOperation(this.draftCatalogLoader(draft));
      const { host, target, project } = await this.projectTarget(draft.workspaceId);
      if (
        target.hostId !== draft.target.hostId ||
        target.epoch !== draft.target.epoch ||
        target.cwd !== draft.target.cwd
      )
        throw new RpcError(
          "remote/connection-changed",
          "Reopen the draft in the reconnected project.",
        );
      const reply = await this.invoke(operation, () => {
        dispatched = true;
      });
      const result = z.object({ thread: rowSchema }).safeParse(reply);
      if (!result.success || this.closed)
        throw new RpcError(
          "remote/outcome-unknown",
          "Remote Thread creation was not confirmed. Refresh the project before retrying.",
        );
      const thread = result.data.thread;
      const identity = { hostId: host.hostId, threadId: thread.id };
      const id = remoteSessionId(identity.hostId, identity.threadId);
      // A catalog refresh can publish this Thread while startSelected is awaiting its reply.
      const entry: Entry = this.entries.get(id) ?? {
        identity,
        row: { ...thread, turns: [] } as ChThread,
        online: true,
        configurationRevision: 0,
      };
      entry.createdEpoch = target.epoch;
      const draftUploadScope = draft.uploadScope;
      if (draftUploadScope !== undefined) {
        entry.pendingUploadScope = draftUploadScope;
      }
      this.hosts.set(host.hostId, host);
      this.entries.set(id, entry);
      try {
        this.workspaces?.rememberRemoteProject(id, project.id);
      } catch {
        // The Host already created this Thread. Return its ID even if the local disk is full.
        console.warn("[remote-sessions] Could not persist the remote project assignment.");
      }
      draft.canonicalId = id;
      this.pendingFirstTurns.set(id, draft);
      try {
        this.syncGroups();
        this.events.emit("api-session/added", this.summary(id, entry));
        this.events.emit("codexhost/session-bound", draft.id, id);
        this.events.emit("api-session/removed", draft.id);
        if (usePeerAttachments && peerPromptContent !== undefined) {
          await this.attachments.prompt(this.peerEndpoint(host.hostId), {
            threadId: thread.id,
            ...(draftUploadScope !== undefined ? { scope: draftUploadScope } : {}),
            ...(peerPromptRequestId !== undefined ? { requestId: peerPromptRequestId } : {}),
            ...(peerPromptMode !== undefined ? { mode: peerPromptMode } : {}),
            content: peerPromptContent,
          });
          if (draftUploadScope !== undefined && entry.pendingUploadScope === draftUploadScope) {
            delete entry.pendingUploadScope;
          }
        } else if (legacyPrompt !== undefined) {
          await this.invoke({ ...legacyPrompt, threadId: thread.id });
        }
      } finally {
        this.pendingFirstTurns.delete(id);
      }
      const peerSource = isPeer ? this.peers?.source(host.hostId) : undefined;
      if (peerSource) {
        const titlePrompt =
          usePeerAttachments && peerPromptContent !== undefined
            ? peerPromptContent
                .filter(
                  (part): part is Extract<typeof part, { type: "text" }> => part.type === "text",
                )
                .map((part) => part.text)
                .join("\n")
            : (legacyPrompt?.text ?? "");
        const external =
          (operation.kind === "startSelected" && operation.harnessId !== "codex") ||
          thread.modelProvider === "codexhost";
        this.titleRequests.add(id);
        void tryGenerateThreadTitle(
          peerSource.host,
          entry.row,
          titlePrompt,
          external,
          () => !this.closed && this.titleRequests.has(id),
        )
          .then((changed) => {
            if (changed && !this.closed) this.hostsChanged(host.hostId);
          })
          .catch(() => undefined)
          .finally(() => this.titleRequests.delete(id));
      }
      void this.read(id).catch(() => undefined);
      return { accepted: true };
    })().catch((error: unknown) => {
      if (!dispatched) delete draft.submission;
      throw error;
    });
    draft.sending = true;
    draft.submission = {
      key,
      result: result.finally(() => {
        draft.sending = false;
      }),
    };
    return draft.submission.result;
  }
  private syncGroups(): void {
    this.workspaces?.setRemoteGroups(
      remoteWorkspaceGroups(this.hosts.values(), [
        ...[...this.entries].map(([sessionId, entry]) => ({
          sessionId,
          ...entry.identity,
          cwd: entry.row.cwd,
          projectId: this.workspaces?.remoteProjectId(sessionId),
        })),
        ...[...this.drafts.values()]
          .filter((d) => !d.canonicalId)
          .map((d) => ({
            sessionId: d.id,
            hostId: d.target.hostId,
            threadId: d.id,
            cwd: d.target.cwd,
            projectId: d.projectId,
          })),
      ]),
    );
  }
  private reference(entry: Entry) {
    return { ...entry.identity };
  }
  private async configureRemote(entry: Entry, setting: RemoteConfigurationSetting): Promise<void> {
    if (!entry.epoch) throw new RpcError("remote/offline", "Remote connection changed");
    const configuration = modelConfiguration(entry);
    const epoch = entry.epoch;
    let result: unknown;
    try {
      result = await this.invoke({
        kind: "configure",
        ...entry.identity,
        epoch,
        ...setting,
      });
    } finally {
      // Invalidate a read that started before the native mutation settled. The
      // caller refreshes after this wait, so an acknowledged write cannot be
      // overwritten by its pre-mutation snapshot.
      entry.configurationRevision++;
      await entry.reading?.catch(() => undefined);
      if (entry.epoch === epoch && entry.controls) {
        const confirmed = harnessConfigurationStateSchema.safeParse(result);
        // Retain ownership, not pre-mutation effective settings. Missing or
        // malformed confirmations leave those settings unknown until inspected.
        delete entry.controls.nativeModelWithoutTier;
        entry.controls.configuration = {
          ...(configuration.owner === "external"
            ? {
                owner: "external" as const,
                harnessId: configuration.harnessId,
                transportModelId: configuration.transportModelId,
                history: configuration.history,
              }
            : { owner: "codex" as const }),
          locked: true,
          ...(confirmed.success ? confirmed.data : {}),
        };
        if (entry.view) applyRemoteControls(entry, entry.view);
      }
    }
  }
  private syncArchives(): string[] {
    const ids = [...this.entries].filter(([, entry]) => entry.archived).map(([id]) => id);
    this.workspaces?.setRemoteArchives(ids);
    return this.workspaces?.archivedSessionIds() ?? ids;
  }
  private summary(id: string, entry: Entry) {
    const attachmentsSupported =
      entry.online && this.peerAttachmentsSupported(entry.identity.hostId);
    const harnessIdentity =
      remoteHarnessIdentity(entry) ??
      (entry.row.modelProvider !== "codexhost" ? { id: "codex", name: "Codex" } : undefined);
    return {
      sessionId: id,
      cwd: "",
      updatedAt: entry.row.updatedAt * 1000,
      running: entry.online && entry.row.status.type === "active",
      blank: false,
      agentAvailable: entry.online,
      projections: {
        kind: "cached",
        asOfSeq: 0,
        values: {
          ...defaultProjections(),
          title: threadListTitle({ ...entry.row, id: entry.identity.threadId }),
          remoteHost: {
            ...entry.identity,
            displayName: remoteHostDisplayName(
              this.hosts.get(entry.identity.hostId) ?? { hostId: entry.identity.hostId },
            ),
            state: entry.online ? "connected" : "disconnected",
            filePreview: attachmentsSupported,
          },
          ...(harnessIdentity ? { harnessIdentity } : {}),
          ...(entry.peerOwnershipAvailable && entry.peerTreeParent !== undefined
            ? { threadTreeParent: entry.peerTreeParent }
            : {}),
          threadReference: this.reference(entry),
          nativeConnection: { state: entry.online ? "connected" : "reconnecting" },
          nativeDiscovery: false,
          remoteHistoryError: entry.historyError ?? null,
          attachmentInput: { enabled: attachmentsSupported },
          ...(attachmentsSupported ? { imageLimits: WEB_IMAGE_LIMITS } : {}),
          sessionListMetadata: { blank: false, lastPromptAt: entry.row.updatedAt * 1000 },
        },
      },
    };
  }
  private offline(entry: Entry): void {
    const changed = entry.online;
    entry.online = false;
    if (changed) delete entry.usageRequest;
    delete entry.queueReading;
    if (changed) entry.view?.log.setProjection("queueState", { previewOnly: true, stale: true });
    const id = remoteSessionId(entry.identity.hostId, entry.identity.threadId);
    this.clearPending(id);
    const summary = this.summary(id, entry);
    if (changed && !this.closed) this.events.emit("api-session/added", summary);
    entry.view?.log.setProjection("remoteHost", summary.projections.values.remoteHost);
    entry.view?.log.setProjection("attachmentInput", summary.projections.values.attachmentInput);
    entry.view?.log.setProjection("nativeConnection", {
      state: "reconnecting",
      message: entry.identity.hostId.startsWith("remote-peer:")
        ? "Remote peer offline; check its connection."
        : "Remote Host offline; reconnect in Desktop.",
    });
  }
  private clearPending(id: string): void {
    for (const [key, item] of this.pending)
      if (item.sessionId === id) {
        this.pending.delete(key);
        item.cancel();
      }
  }
  async read(id: string, force = false): Promise<ChThreadView> {
    const identity = remoteSessionIdentity(id);
    if (!identity) throw new RpcError("remote/identity-invalid", "Remote identity required");
    let entry = this.entries.get(id);
    if (!entry) {
      await this.refresh();
      entry = this.entries.get(id);
    }
    if (!entry) throw new RpcError("remote/not-found", "Remote Thread not found");
    const current = entry;
    const requireCurrent = () => {
      const active = this.entries.get(id);
      if (this.closed || !active)
        throw new RpcError("remote/not-found", "Remote Thread is no longer available");
      if (active !== current)
        throw new RpcError(
          "remote/connection-changed",
          "Remote Thread changed during history read",
        );
    };
    requireCurrent();
    const peerSource = this.peers?.source(identity.hostId);
    if (peerSource) {
      return this.readPeer(id, current, peerSource, force, requireCurrent);
    }
    this.loadQueue(id, current);
    const configurationRevision = current.configurationRevision;
    const previousView = current.view;
    const previousReadOnly = previousView?.thread.canAcceptDirectInput === false;
    current.reading ??= (async () => {
      try {
        const before = JSON.stringify(this.summary(id, current));
        const snapshot = await readRemoteHistory(
          (operation) => this.invoke(operation),
          identity,
          current.view && current.epoch
            ? {
                thread: current.view.thread,
                epoch: current.epoch,
                fullReadAt: current.fullReadAt ?? 0,
                owner: current.controls?.configuration?.owner,
              }
            : undefined,
        );
        requireCurrent();
        if (snapshot.result.thread.id !== identity.threadId)
          throw new Error("Remote identity mismatch");
        if (configurationRevision !== current.configurationRevision) {
          const view = current.view;
          if (!view) throw new Error("Stale remote read has no current view");
          return view;
        }
        const sameEpoch = current.epoch === snapshot.epoch;
        if (current.epoch && current.epoch !== snapshot.epoch) {
          this.clearPending(id);
          this.retireView(current);
        }
        current.epoch = snapshot.epoch;
        current.fullReadAt = snapshot.fullReadAt;
        current.online = true;
        delete current.historyError;
        current.row = snapshot.result.thread;
        current.controls = mergeRemoteControls(
          current.controls,
          parseRemoteControls(snapshot),
          sameEpoch,
        );
        const row = { ...current.row, id, cwd: "" };
        const harnessId = viewHarnessId(current);
        if (current.view?.thread.turns.some((turn, index) => row.turns[index]?.id !== turn.id))
          this.retireView(current);
        if (!current.view || current.viewHarnessId !== harnessId) {
          if (current.view) this.retireView(current);
          current.view = this.createView(row, harnessId, current.viewOrigin);
          current.viewHarnessId = harnessId;
        }
        try {
          current.view.update(row);
        } catch (error) {
          if (
            !(error instanceof RpcError) ||
            !["host/items-replaced", "host/history-changed"].includes(error.code)
          )
            throw error;
          this.retireView(current);
          current.view = this.createView(row, harnessId, current.viewOrigin);
          current.viewHarnessId = harnessId;
          current.view.update(row);
        }
        for (const [key, value] of Object.entries(this.summary(id, current).projections.values))
          if (
            [
              "threadReference",
              "title",
              "nativeConnection",
              "nativeDiscovery",
              "attachmentInput",
              "remoteHost",
              "harnessIdentity",
              "remoteHistoryError",
            ].includes(key)
          )
            current.view.log.setProjection(key, value);
        current.view.log.setProjection("harnessIdentity", remoteHarnessIdentity(current) ?? null);
        applyRemoteControls(current, current.view);
        if (
          current.view !== previousView ||
          (current.view.thread.canAcceptDirectInput === false) !== previousReadOnly
        )
          this.loadQueue(id, current);
        this.loadUsage(id, current, current.view, snapshot.epoch);
        this.interactions(id, current, snapshot.requests);
        if (
          snapshot.interactionsAvailable === false ||
          snapshot.requests.some(
            (request) =>
              ![
                "item/commandExecution/requestApproval",
                "item/fileChange/requestApproval",
              ].includes(request.method),
          )
        )
          current.view.log.setProjection(
            "nativeInteractionError",
            "This Desktop connection requires answering its native interactions in Codex Desktop.",
          );
        const summary = this.summary(id, current);
        if (JSON.stringify(summary) !== before) this.events.emit("api-session/added", summary);
        this.events.emit("api-session/status", id, summary.running);
        return current.view;
      } catch (error) {
        requireCurrent();
        if (error instanceof RpcError && error.code === "remote/offline") this.offline(current);
        else if (!this.closed) {
          if (error instanceof RpcError && error.code === "remote/connection-changed")
            this.clearPending(id);
          current.historyError = {
            code: error instanceof RpcError ? error.code : "remote/read-failed",
            message: error instanceof Error ? error.message : String(error),
          };
          current.view?.log.setProjection("remoteHistoryError", current.historyError);
          this.events.emit("api-session/added", this.summary(id, current));
        }
        throw error;
      }
    })().finally(() => {
      delete current.reading;
    });
    return current.reading;
  }
  private readPeer(
    id: string,
    current: Entry,
    source: PeerThreadSource,
    force: boolean,
    requireCurrent: () => void,
  ): Promise<ChThreadView> {
    const configurationRevision = current.configurationRevision;
    current.reading ??= (async () => {
      try {
        const before = JSON.stringify(this.summary(id, current));
        let history = source.history(current.identity.threadId, id, current.viewOrigin, {
          row: current.row,
          harnessId: viewHarnessId(current),
          onProjection: this.controlProjectionListener,
        });
        try {
          await history.refresh(force);
        } catch (error) {
          if (
            !(error instanceof RpcError) ||
            !["host/history-changed", "host/items-replaced"].includes(error.code)
          ) {
            throw error;
          }
          this.retireView(current, source);
          history = source.history(current.identity.threadId, id, current.viewOrigin, {
            row: current.row,
            harnessId: viewHarnessId(current),
            onProjection: this.controlProjectionListener,
          });
          await history.refresh(true);
        }
        requireCurrent();
        const snapshot = history.ownerSnapshot;
        const snapshotEpoch =
          snapshot?.cursor.epoch ?? this.hosts.get(current.identity.hostId)?.epoch ?? current.epoch;
        const sameEpoch = !current.epoch || !snapshotEpoch || current.epoch === snapshotEpoch;
        if (current.epoch && snapshotEpoch && current.epoch !== snapshotEpoch) {
          this.clearPending(id);
          delete current.controls;
          delete current.peerInspected;
        }
        if (snapshotEpoch) current.epoch = snapshotEpoch;
        current.online = true;
        delete current.historyError;
        if (snapshot) {
          current.row = { ...snapshot.thread, turns: [] } as ChThread;
        }
        current.view = history;
        current.viewHarnessId = viewHarnessId(current);

        const needsInspect =
          !current.peerInspected ||
          current.peerInspected.view !== history ||
          current.peerInspected.epoch !== current.epoch ||
          current.peerInspected.revision !== configurationRevision;

        if (needsInspect) {
          const configuration = await source.host
            .request("codexhost/thread/inspect", { threadId: current.identity.threadId })
            .catch(() => undefined);
          const parsedConfig = threadInspectionSchema.safeParse(configuration);
          const harnessId = parsedConfig.success
            ? parsedConfig.data.owner === "codex"
              ? "codex"
              : parsedConfig.data.harnessId
            : (current.peerHarnessIdentity?.id ??
              (current.row.modelProvider !== "codexhost" ? "codex" : undefined));
          const [inspection, plugins] = harnessId
            ? await Promise.all([
                source.catalog.inspect(harnessId, current.row.cwd).catch(() => undefined),
                harnessId === "codex"
                  ? Promise.resolve(undefined)
                  : source.catalog.list().catch(() => undefined),
              ])
            : [undefined, undefined];
          requireCurrent();
          if (configurationRevision !== current.configurationRevision) {
            return current.view ?? history;
          }
          const plugin = plugins?.find((p) => p.id === harnessId);
          const harness = plugin ? { id: plugin.id, name: plugin.name } : undefined;
          current.controls = mergeRemoteControls(
            current.controls,
            parseRemoteControls({
              configuration,
              nativeSettings: snapshot?.configuration.native,
              inspection,
              harness,
            }),
            sameEpoch,
          );
          if (current.epoch) {
            current.peerInspected = {
              view: history,
              epoch: current.epoch,
              revision: configurationRevision,
            };
          }
          current.viewHarnessId = viewHarnessId(current);
        } else if (snapshot?.configuration.native) {
          current.controls = mergeRemoteControls(
            current.controls,
            parseRemoteControls({
              configuration: current.controls?.configuration,
              nativeSettings: snapshot.configuration.native,
            }),
            true,
          );
        }

        const summary = this.summary(id, current);
        for (const [key, value] of Object.entries(summary.projections.values)) {
          if (
            [
              "threadReference",
              "threadTreeParent",
              "title",
              "nativeConnection",
              "nativeDiscovery",
              "attachmentInput",
              "imageLimits",
              "remoteHost",
              "harnessIdentity",
              "remoteHistoryError",
            ].includes(key)
          ) {
            history.log.setProjection(key, value);
          }
        }
        history.log.setProjection("harnessIdentity", remoteHarnessIdentity(current) ?? null);
        applyRemoteControls(current, history);
        if (current.epoch) this.loadUsage(id, current, history, current.epoch);
        const requests: PendingRequest[] = (snapshot?.interactions ?? []).flatMap((item) => {
          const method = typeof item.request.method === "string" ? item.request.method : undefined;
          const params =
            item.request.params &&
            typeof item.request.params === "object" &&
            !Array.isArray(item.request.params)
              ? (item.request.params as Record<string, unknown>)
              : {};
          return method ? [{ ...item.request, id: item.requestId, method, params }] : [];
        });
        this.interactions(id, current, requests);
        if (JSON.stringify(summary) !== before) this.events.emit("api-session/added", summary);
        this.events.emit("api-session/status", id, summary.running);
        return history;
      } catch (error) {
        requireCurrent();
        if (error instanceof RpcError && error.code === "remote/offline") this.offline(current);
        else if (!this.closed) {
          if (error instanceof RpcError && error.code === "remote/connection-changed")
            this.clearPending(id);
          current.historyError = {
            code: error instanceof RpcError ? error.code : "remote/read-failed",
            message: error instanceof Error ? error.message : String(error),
          };
          current.view?.log.setProjection("remoteHistoryError", current.historyError);
          this.events.emit("api-session/added", this.summary(id, current));
        }
        throw error;
      }
    })().finally(() => {
      delete current.reading;
    });
    return current.reading;
  }
  private async followPeer(
    sessionId: string,
    threadId: string,
    source: PeerThreadSource,
    sink: StreamSink,
    request: Parameters<ChThreadView["log"]["follow"]>[1],
  ): Promise<void> {
    if (sink.closed || this.closed) return;
    const unfollow = source.follow(threadId);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      unfollow();
    };
    sink.onClose(release);
    try {
      const view = await this.read(sessionId);
      if (sink.closed || this.closed) {
        release();
        return;
      }
      view.log.follow(toolOutputSink(view.log, sink), request);
    } catch (error) {
      release();
      throw error;
    }
  }
  private async archivePeer(
    source: PeerThreadSource,
    hostId: string,
    threadId: string,
    epoch: string,
    archived: boolean,
  ): Promise<void> {
    const peerArchived = this.peerArchivedIds.get(hostId) ?? new Set<string>();
    const updated: string[] = [];
    const setMemberArchived = async (memberId: string) => {
      await this.invoke({
        kind: "archive",
        hostId,
        threadId: memberId,
        epoch,
        archived,
      });
      updated.push(memberId);
    };
    try {
      await source.tree.archive(threadId, archived, peerArchived, setMemberArchived);
    } catch (error) {
      if (updated.length === 0 && isMethodUnavailableError(error)) {
        await setMemberArchived(threadId);
      } else {
        throw error;
      }
    } finally {
      for (const memberId of updated) {
        if (archived) peerArchived.add(memberId);
        else peerArchived.delete(memberId);
        const memberEntry = this.entries.get(remoteSessionId(hostId, memberId));
        if (memberEntry) memberEntry.archived = archived;
      }
      this.peerArchivedIds.set(hostId, peerArchived);
      if (updated.length > 0) this.syncArchives();
    }
  }
  private loadQueue(id: string, entry: Entry): void {
    const { view, epoch } = entry;
    if (this.closed || this.entries.get(id) !== entry || !entry.online || !view || !epoch) return;
    const project = (key: "inbox" | "queueState", value: unknown) => {
      if (JSON.stringify(view.log.projections[key]) !== JSON.stringify(value))
        view.log.setProjection(key, value);
    };
    if (view.thread.canAcceptDirectInput === false) {
      project("queueState", { previewOnly: true });
      project("inbox", { "next-turn": [], "next-step": [] });
      return;
    }
    if (entry.queueReading) return;
    const isCurrent = () =>
      !this.closed &&
      this.entries.get(id) === entry &&
      entry.online &&
      entry.view === view &&
      entry.epoch === epoch &&
      entry.queueReading === loading;
    const loading = this.invoke({ kind: "queue", ...entry.identity, epoch })
      .then((raw) => {
        if (!isCurrent() || view.thread.canAcceptDirectInput === false) return;
        const queue = remoteQueueSnapshotSchema.parse(raw);
        project("queueState", { previewOnly: true });
        project("inbox", {
          "next-turn": (queue.available ? queue.items : []).map((item) => ({
            id: item.id,
            role: "user",
            content: [{ type: "text", text: item.preview }],
            source: { kind: "user", rpcId: item.clientUserMessageId },
          })),
          "next-step": [],
        });
      })
      .catch(() => {
        if (isCurrent() && view.thread.canAcceptDirectInput !== false)
          project("queueState", { previewOnly: true, stale: true });
      })
      .finally(() => {
        if (entry.queueReading === loading) delete entry.queueReading;
      });
    entry.queueReading = loading;
  }
  private refreshAfterDelivery(id: string, entry: Entry): void {
    if (!entry.view) return;
    // Queue receipts can confirm delivery even while history is unavailable.
    if (!this.peers?.source(entry.identity.hostId)) {
      void Promise.resolve(entry.queueReading).then(() => this.loadQueue(id, entry));
    }
    void Promise.allSettled([entry.reading])
      .then(() => {
        if (!this.closed && this.entries.get(id) === entry) return this.read(id);
      })
      .catch(() => undefined);
  }
  private loadUsage(
    id: string,
    entry: Entry,
    view: ChThreadView,
    epoch: string,
    force = false,
  ): void {
    const updatedAt = view.thread.updatedAt;
    const lastTurnId = view.thread.turns.at(-1)?.id;
    const previous = entry.usageRequest;
    if (
      previous?.view === view &&
      (previous.pending ||
        (!force &&
          previous.updatedAt === updatedAt &&
          previous.lastTurnId === lastTurnId &&
          Date.now() < previous.retryAt))
    ) {
      if (force && previous.pending) previous.dirty = true;
      return;
    }
    const request: NonNullable<Entry["usageRequest"]> = {
      view,
      updatedAt,
      lastTurnId,
      retryAt: 0,
      pending: true,
    };
    entry.usageRequest = request;
    const matchesHistory = () =>
      view.thread.updatedAt === updatedAt && view.thread.turns.at(-1)?.id === lastTurnId;
    const isCurrent = () =>
      !this.closed &&
      this.entries.get(id) === entry &&
      entry.online &&
      entry.view === view &&
      entry.epoch === epoch &&
      entry.usageRequest === request;
    void this.invoke({ kind: "usage", ...entry.identity, epoch })
      .then((raw) => {
        const parsed = threadUsageInspectionSchema.safeParse(raw);
        if (
          parsed.success &&
          parsed.data.threadId === entry.identity.threadId &&
          isCurrent() &&
          matchesHistory()
        )
          applyUsageProjections(view.log, parsed.data);
      })
      .catch(() => {
        // Usage is optional. Keep the last confirmed projection if the remote read fails.
      })
      .finally(() => {
        request.pending = false;
        request.retryAt = Date.now() + 30_000;
        const rerunForUpdate = request.dirty === true;
        delete request.dirty;
        // Re-fetch when history or a usage update event arrived while this request was in flight.
        if (isCurrent() && (rerunForUpdate || !matchesHistory()))
          this.loadUsage(id, entry, view, epoch, rerunForUpdate);
      });
  }
  private retireView(entry: Entry, peerSource?: PeerThreadSource): void {
    if (!entry.view) return;
    entry.viewOrigin = entry.view.log.lastSeq + 1;
    (peerSource ?? this.peers?.source(entry.identity.hostId))?.discard(entry.identity.threadId);
    entry.view.retire();
    entry.view.log.reconnectFollowers();
    delete entry.view;
    delete entry.viewHarnessId;
    delete entry.peerInspected;
    delete entry.usageRequest;
    delete entry.queueReading;
  }
  private createView(row: ChThread, harnessId: string, origin = 0): ChThreadView {
    const view = new ChThreadView(
      row,
      harnessId,
      (sessionId, key, value, seq) => {
        view.log.pushProjection(key, value, seq);
        if (WEB_FOLLOW_PROJECTION_KEYS.has(key)) return;
        for (const sink of this.controls)
          sink.push({ type: "projection", sessionId, key, value, seq });
      },
      0,
      origin,
    );
    return view;
  }
  private interactions(id: string, entry: Entry, requests: PendingRequest[]): void {
    const supported = requests.filter((request) =>
      ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(
        request.method,
      ),
    );
    const keyOf = (request: PendingRequest) => JSON.stringify([id, entry.epoch, request.id]);
    const keys = new Set(supported.map(keyOf));
    for (const [key, pending] of this.pending)
      if (pending.sessionId === id && !keys.has(key)) {
        this.pending.delete(key);
        pending.cancel();
      }
    for (const request of supported) {
      const key = keyOf(request);
      if (this.pending.has(key)) continue;
      const epoch = entry.epoch;
      if (!epoch) continue;
      const invocation = this.events.invoke(
        "approval/request",
        id,
        remoteApprovalPresentation(request, entry.row),
      );
      const pending = { sessionId: id, cancel: invocation.cancel };
      this.pending.set(key, pending);
      void invocation.result.then(
        async (answer) => {
          if (this.pending.get(key) !== pending) return;
          const decision = answer === "allowed-once" ? "accept" : "decline";
          try {
            await this.invoke({
              kind: "respond",
              ...entry.identity,
              epoch,
              requestId: request.id,
              result: { decision },
            });
          } catch (error) {
            entry.view?.log.setProjection("nativeInteractionError", String(error));
          }
          // Retain the key until the authoritative native pending list removes it.
        },
        () => {},
      );
    }
  }
  install(rpc: RpcRegistry, streams: StreamRegistry): void {
    rpc.routeSessions(async (method, args, next) => {
      if (method === "session/create") {
        const request = requestOf<{ workspaceId?: string; cwd?: string; sessionId?: string }>(args);
        if (
          typeof request.workspaceId === "string" &&
          request.workspaceId.startsWith("remote-workspace:")
        ) {
          if (request.cwd !== undefined)
            throw new RpcError(
              "remote/invalid-request",
              "Choose a remote project to create a new Thread.",
            );
          return this.createInProject(request.workspaceId, request.sessionId);
        }
      }
      if (method === "session/list") {
        const request = requestOf<{ sessionId?: unknown; cursor?: unknown }>(args);
        if (request.sessionId !== undefined) {
          const id = request.sessionId;
          if (typeof id !== "string" || !id.startsWith(PREFIX)) return next();
          if (request.cursor !== undefined)
            throw new RpcError("session/list-invalid", "Invalid direct-link identity.");
          const draft = this.drafts.get(id);
          if (draft && !draft.canonicalId)
            return { items: [this.draftSummary(draft)], archivedSessionIds: this.syncArchives() };
          const canonicalId = draft?.canonicalId ?? id;
          remoteSessionIdentity(canonicalId);
          if (!this.entries.has(canonicalId)) await this.refresh();
          const entry = this.entries.get(canonicalId);
          if (!entry) throw new RpcError("remote/not-found", "Remote Thread not found");
          return {
            items: [this.summary(canonicalId, entry)],
            archivedSessionIds: this.syncArchives(),
          };
        }
        void this.refresh().catch(() => undefined);
        const local = await next();
        return {
          ...(local as object),
          items: [
            ...(local as { items: unknown[] }).items,
            ...[...this.drafts.values()]
              .filter((d) => !d.canonicalId)
              .map((d) => this.draftSummary(d)),
            ...[...this.entries].map(([id, entry]) => this.summary(id, entry)),
          ],
        };
      }
      const request = requestOf<{
        sessionId?: string;
        address?: { sessionId?: string };
        agentId?: string;
      }>(args);
      const id = request.sessionId ?? request.address?.sessionId ?? request.agentId ?? args.agentId;
      if (typeof id !== "string" || !id.startsWith(PREFIX)) return next();
      if (method === "session/prompt") {
        const pending = this.pendingFirstTurns.get(id);
        if (pending) return this.firstTurn(pending, request as Record<string, unknown>);
      }
      const draft = this.drafts.get(id);
      if (draft) {
        draft.lastUsed = Date.now();
        const input = request as Record<string, unknown>;
        if (method === "session/prompt") return this.firstTurn(draft, input);
        if (draft.canonicalId) return this.handle(method, draft.canonicalId, input);
        switch (method) {
          case "session/modelCatalog":
            return draft.catalog(this.draftCatalogLoader(draft));
          case "session/projections":
            return this.draftSummary(draft).projections;
          case "session/selectModel": {
            await draft.select(input, this.draftCatalogLoader(draft));
            const summary = this.draftSummary(draft);
            this.events.emit("api-session/added", summary);
            for (const sink of this.controls)
              for (const [key, value] of Object.entries(summary.projections.values))
                sink.push({ type: "projection", sessionId: id, key, value, seq: 0 });
            return {};
          }
          default:
            throw new RpcError(
              "remote/unsupported",
              "This operation needs a submitted remote Thread.",
            );
        }
      }
      return this.handle(method, id, request as Record<string, unknown>);
    });
    streams.routeSessions(async (endpoint, args, sink, next) => {
      if (endpoint === "session/control") {
        sink.onClose(() => this.controls.delete(sink));
        await next({
          ...sink,
          get closed() {
            return sink.closed;
          },
          push: (frame) => {
            sink.push(frame);
            if (
              !sink.closed &&
              typeof frame === "object" &&
              frame !== null &&
              "type" in frame &&
              frame.type === "baseline"
            )
              this.controls.add(sink);
          },
        });
        return true;
      }
      const request = requestOf<{ address?: { sessionId?: string } }>(args);
      const id = request.address?.sessionId;
      if (typeof id !== "string" || !id.startsWith(PREFIX)) return false;
      if (endpoint !== "session/follow")
        throw new RpcError("remote/unsupported", "This remote stream is unavailable");
      const draft = this.drafts.get(id);
      if (draft && !draft.canonicalId) {
        draft.lastUsed = Date.now();
        draft.follow(sink, this.peerAttachmentsSupported(draft.target.hostId));
        return true;
      }
      const threadId = draft?.canonicalId ?? id;
      const identity = remoteSessionIdentity(threadId);
      const peerSource = identity ? this.peers?.source(identity.hostId) : undefined;
      if (identity && peerSource) {
        await this.followPeer(threadId, identity.threadId, peerSource, sink, requestOf(args));
        return true;
      }
      await followRemoteHistory(
        () => this.read(threadId),
        sink,
        requestOf(args),
        this.followLifetime.signal,
        () => this.entries.get(threadId)?.historyError,
        (view) => this.entries.get(threadId)?.view === view,
        (view) => {
          const entry = this.entries.get(threadId);
          if (entry?.view === view) this.loadQueue(threadId, entry);
        },
      );
      return true;
    });
  }
  private async handle(
    method: string,
    id: string,
    request: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === "session/attachment") {
      const identity = remoteSessionIdentity(id);
      if (!identity) throw new RpcError("remote/identity-invalid", "Remote identity required");
      if (!identity.hostId.startsWith(REMOTE_PEER_HOST_ID_PREFIX)) {
        throw new RpcError(
          "remote/unsupported",
          "This operation is unavailable for remote Threads",
        );
      }
      const attachmentId = typeof request.attachmentId === "string" ? request.attachmentId : "";
      if (!attachmentId) {
        throw new RpcError("session/attachment-not-found", "The referenced image is unavailable.");
      }
      const peer = this.peerEndpoint(identity.hostId);
      if (!this.attachments.supported(peer)) {
        throw new RpcError(
          "remote/attachments-unsupported",
          "Remote peer does not support attachments.",
        );
      }
      const view = this.entries.get(id)?.view ?? (await this.read(id));
      return this.attachments.readAttachment(peer, view, identity.threadId, attachmentId);
    }
    if (method === "session/prompt") {
      const identity = remoteSessionIdentity(id);
      if (!identity) throw new RpcError("remote/identity-invalid", "Remote identity required");
      const isPeer = identity.hostId.startsWith(REMOTE_PEER_HOST_ID_PREFIX);
      if (!isPeer && hasContentPartType(request.content, "file")) {
        throw new RpcError(
          "remote/attachments-unsupported",
          "Remote attachments are not supported for this host.",
        );
      }
      if (isPeer && hasNonTextContentPart(request.content)) {
        const peer = this.peerEndpoint(identity.hostId);
        if (!this.attachments.supported(peer)) {
          throw new RpcError(
            "remote/attachments-unsupported",
            "Remote peer does not support attachments.",
          );
        }
        if (hasContentPartType(request.content, "image")) {
          throw new RpcError(
            "session/attachment-invalid",
            "Encoded image parts are not supported for remote peer sessions.",
            { reason: "REMOTE_ENCODED_IMAGE_UNSUPPORTED" },
          );
        }
        if (!this.entries.has(id)) await this.refresh();
        const entry = this.entries.get(id);
        if (!entry) throw new RpcError("remote/not-found", "Remote Thread not found");
        const pendingScope = entry.pendingUploadScope;
        try {
          const result = await this.attachments.prompt(peer, {
            threadId: identity.threadId,
            ...(pendingScope !== undefined ? { scope: pendingScope } : {}),
            ...(typeof request.requestId === "string" ? { requestId: request.requestId } : {}),
            ...(request.mode !== undefined ? { mode: request.mode as "queue" | "steer" } : {}),
            ...(request.expectedTurnId === null || typeof request.expectedTurnId === "string"
              ? { expectedTurnId: request.expectedTurnId }
              : {}),
            content: request.content as RemotePeerPromptParams["content"],
          });
          if (pendingScope !== undefined && entry.pendingUploadScope === pendingScope) {
            delete entry.pendingUploadScope;
          }
          return result;
        } finally {
          this.refreshAfterDelivery(id, entry);
        }
      }
    }
    if (
      (method === "session/prompt" && request.mode !== undefined) ||
      method === "session/updateQueue"
    ) {
      const identity = remoteSessionIdentity(id);
      if (!identity) throw new RpcError("remote/identity-invalid", "Remote identity required");
      if (!this.entries.has(id)) await this.refresh();
      const entry = this.entries.get(id);
      if (!entry) throw new RpcError("remote/not-found", "Remote Thread not found");
      const invoke = (operation: RemoteSessionOperation) => {
        if (this.entries.get(id) !== entry)
          throw new RpcError("remote/connection-changed", "Remote Thread changed before dispatch.");
        return this.invoke(operation);
      };
      try {
        return await deliverRemoteInput(invoke, identity, method, request, async () => {
          const view = await this.read(id);
          if (this.entries.get(id) !== entry || !entry.epoch)
            throw new RpcError(
              "remote/connection-changed",
              "Remote Thread changed before dispatch.",
            );
          return {
            threadId: identity.threadId,
            status: view.thread.status.type,
            turnId: null,
            epoch: entry.epoch,
            ...(view.thread.canAcceptDirectInput === false ? { readOnly: true } : {}),
          };
        });
      } finally {
        this.refreshAfterDelivery(id, entry);
      }
    }
    if (method === "session/cancel") {
      const identity = remoteSessionIdentity(id);
      if (!identity) throw new RpcError("remote/identity-invalid", "Remote identity required");
      const status = await readRemoteThreadStatus((operation) => this.invoke(operation), identity);
      if (status.status !== "active" || status.turnId === null)
        throw new RpcError("remote/stop-unavailable", "No confirmed current Turn to interrupt");
      await this.invoke({
        kind: "interrupt",
        ...identity,
        epoch: status.epoch,
        turnId: status.turnId,
      });
      return { accepted: true };
    }
    if (method === "session/unarchive" || method === "workspace/unarchiveSession") {
      const identity = remoteSessionIdentity(id);
      if (!identity) throw new RpcError("remote/identity-invalid", "Remote identity required");
      let entry = this.entries.get(id);
      let epoch = this.hosts.get(identity.hostId)?.epoch ?? entry?.epoch;
      if (!epoch) {
        await this.refresh(identity.hostId);
        entry = this.entries.get(id);
        epoch = this.hosts.get(identity.hostId)?.epoch ?? entry?.epoch;
      }
      if (!epoch) {
        await this.read(id);
        entry = this.entries.get(id);
        epoch = entry?.epoch;
      }
      if (!epoch) throw new RpcError("remote/offline", "Remote connection changed");
      const peerSource = this.peers?.source(identity.hostId);
      const operation: RemoteSessionOperation = {
        kind: "archive",
        ...identity,
        epoch,
        archived: false,
      };
      this.archiveWrites++;
      this.archiveRevision++;
      try {
        if (peerSource && request.scope !== "single") {
          await this.archivePeer(peerSource, identity.hostId, identity.threadId, epoch, false);
        } else {
          await this.invoke(operation);
        }
      } finally {
        this.archiveWrites--;
        this.archiveRevision++;
        if (this.archiveWrites === 0 && !this.closed && !this.listing && this.hasPendingRefresh()) {
          this.refreshPending = false;
          void this.startRefresh().catch(() => undefined);
        }
      }
      if (entry) {
        entry.archived = false;
        this.syncArchives();
      }
      await this.read(id).catch(() => undefined);
      return method === "workspace/unarchiveSession"
        ? { archivedSessionIds: this.syncArchives() }
        : { accepted: true };
    }
    const readOnly = [
      "session/projections",
      "session/page",
      "session/toolOutput",
      "session/modelCatalog",
    ].includes(method);
    const existingEntry = this.entries.get(id);
    const needsPeerCatalogRefresh =
      method === "session/modelCatalog" &&
      existingEntry !== undefined &&
      this.peers?.source(existingEntry.identity.hostId) !== undefined &&
      !existingEntry.peerInspected;
    const cached = readOnly && !needsPeerCatalogRefresh ? existingEntry?.view : undefined;
    const view = cached ?? (await this.read(id));
    if (method === "session/projections") return view.log.projectionBaseline();
    if (method === "session/page") {
      const throughSeq = Number(request.throughSeq);
      const beforeSeq = typeof request.beforeSeq === "number" ? request.beforeSeq : undefined;
      const maxMessages = typeof request.maxMessages === "number" ? request.maxMessages : 20;
      if (view instanceof ChThreadHistory) {
        return view.olderPage(throughSeq, beforeSeq, maxMessages);
      }
      return view.log.page(throughSeq, beforeSeq, { maxMessages });
    }
    if (method === "session/toolOutput")
      return readToolOutput(view.log, webToolOutputReferenceSchema.parse(request));
    const entry = this.entries.get(id);
    if (!entry?.epoch) throw new RpcError("remote/offline", "Remote connection changed");
    if (method === "session/modelCatalog") return remoteModelCatalog(entry);
    if (method === "session/selectModel")
      return selectRemoteModel(
        id,
        entry,
        request,
        (target, setting) => this.configureRemote(target as Entry, setting),
        (sessionId) => this.read(sessionId),
      );
    if (method === "commands/execute")
      return executeRemoteCommand(
        id,
        entry,
        request,
        (target, setting) => this.configureRemote(target as Entry, setting),
        (sessionId) => this.read(sessionId),
      );
    const base = { ...entry.identity, epoch: entry.epoch };
    let operation: RemoteSessionOperation;
    switch (method) {
      case "session/prompt": {
        const text = remotePromptText(request.content);
        if (view.thread.canAcceptDirectInput === false)
          throw new RpcError(
            "remote/send-rejected",
            "This remote Thread does not accept direct input.",
          );
        if (entry.row.status.type === "active")
          throw new RpcError("remote/busy", "Wait for the remote turn or stop it before sending");
        operation = {
          kind: "prompt",
          ...base,
          text,
          ...(typeof request.requestId === "string" ? { requestId: request.requestId } : {}),
        };
        break;
      }
      case "session/rename":
        this.titleRequests.delete(id);
        operation = { kind: "rename", ...base, name: String(request.title ?? "") };
        break;
      case "session/archive":
      case "session/unarchive":
      case "workspace/archiveSession":
      case "workspace/unarchiveSession":
        operation = {
          kind: "archive",
          ...base,
          archived: method === "session/archive" || method === "workspace/archiveSession",
        };
        break;
      default:
        throw new RpcError(
          "remote/unsupported",
          "This operation is unavailable for remote Threads",
        );
    }
    if (operation.kind === "archive") {
      this.archiveWrites++;
      this.archiveRevision++;
    }
    const peerSource =
      operation.kind === "archive" ? this.peers?.source(entry.identity.hostId) : undefined;
    try {
      if (operation.kind === "archive" && peerSource && request.scope !== "single") {
        await this.archivePeer(
          peerSource,
          entry.identity.hostId,
          entry.identity.threadId,
          entry.epoch,
          operation.archived,
        );
      } else {
        await this.invoke(operation);
      }
    } finally {
      if (operation.kind === "archive") {
        this.archiveWrites--;
        this.archiveRevision++;
        if (this.archiveWrites === 0 && !this.closed && !this.listing && this.hasPendingRefresh()) {
          this.refreshPending = false;
          void this.startRefresh().catch(() => undefined);
        }
      }
    }
    if (operation.kind === "archive") {
      // Keep the confirmed row for undo even after it leaves the active catalog.
      entry.archived = operation.archived;
      this.syncArchives();
    }
    // A failed read cannot turn an acknowledged mutation into a rejected write.
    await this.read(id).catch(() => undefined);
    if (method === "workspace/archiveSession" || method === "workspace/unarchiveSession")
      return { archivedSessionIds: this.syncArchives() };
    return method === "session/rename"
      ? { title: request.title, seq: view.log.lastSeq }
      : { accepted: true };
  }
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.followLifetime.abort();
    if (this.peers) {
      if (this.peers.onThreadChanged === this.peerHandlers.onThreadChanged)
        delete this.peers.onThreadChanged;
      if (this.peers.onUsageChanged === this.peerHandlers.onUsageChanged)
        delete this.peers.onUsageChanged;
      if (this.peers.onCatalogInspectionChanged === this.peerHandlers.onCatalogInspectionChanged)
        delete this.peers.onCatalogInspectionChanged;
      if (this.peers.onConnection === this.peerHandlers.onConnection)
        delete this.peers.onConnection;
      if (this.peers.onReset === this.peerHandlers.onReset) delete this.peers.onReset;
    }
    for (const id of this.entries.keys()) this.clearPending(id);
    for (const entry of this.entries.values()) entry.view?.log.reconnectFollowers();
    this.peerArchivedIds.clear();
    this.controls.clear();
    this.drafts.clear();
    this.titleRequests.clear();
  }
}
