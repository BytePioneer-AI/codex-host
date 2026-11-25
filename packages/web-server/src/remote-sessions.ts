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
  hostThreadIdSchema,
  REMOTE_PEER_HOST_ID_PREFIX,
  remotePeerColorSchema,
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
  webTurnDiffsRequestSchema,
  type HarnessCommandCatalog,
  type RemotePeerPromptParams,
  type RemoteSessionOperation,
  type SkillsListResult,
} from "@codexhost/shared-contracts";
import { ChInteractions } from "./ch-interactions.ts";
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
const PEER_CATALOG_REFRESH_MIN_INTERVAL_MS = 600;
const hostsSchema = z.array(
  z.object({
    hostId: z.string().min(1),
    online: z.boolean(),
    epoch: z.string().min(1).optional(),
    displayName: z.string().optional(),
    color: remotePeerColorSchema.optional(),
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
  waitForInitialConnection?(hostId: string): Promise<void>;
  onThreadChanged?: (hostId: string, threadId: string) => unknown;
  onUsageChanged?: (hostId: string, threadId: string) => void;
  onCatalogInspectionChanged?: (hostId: string) => void;
  onSkillsChanged?: (hostId: string) => void;
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
  /** True once a non-null delegation parent has been observed, so legacy fallback clears it explicitly. */
  hadPeerTreeParent?: boolean;
  /** Fingerprints of catalog projections last confirmed on a retired view, avoiding redundant frames. */
  retiredCatalogProjections?: Map<string, string>;
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
  private peerInteractions = new Map<
    string,
    { realtime: NonNullable<PeerThreadSource["host"]["realtime"]>; interactions: ChInteractions }
  >();
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
    onSkillsChanged: (hostId: string) => void;
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
      onSkillsChanged: () => this.handlePeerSkillsChanged(),
      onConnection: (hostId, online) => this.handlePeerConnection(hostId, online),
      onReset: (hostId, epoch, full) => this.handlePeerReset(hostId, epoch, full),
    };
    if (peers) {
      peers.onThreadChanged ??= this.peerHandlers.onThreadChanged;
      peers.onUsageChanged ??= this.peerHandlers.onUsageChanged;
      peers.onCatalogInspectionChanged ??= this.peerHandlers.onCatalogInspectionChanged;
      peers.onSkillsChanged ??= this.peerHandlers.onSkillsChanged;
      peers.onConnection ??= this.peerHandlers.onConnection;
      peers.onReset ??= this.peerHandlers.onReset;
    }
    this.timer = setInterval(() => {
      if (this.controls.size) void this.refreshBackground().catch(() => undefined);
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
  private handlePeerSkillsChanged(): void {
    if (this.closed) return;
    this.events.emit("codexhost/skills/changed");
  }
  private handlePeerConnection(hostId: string, online: boolean): void {
    if (this.closed || online) return;
    const pendingLookup = this.pendingPeerLookups.get(hostId);
    if (pendingLookup) {
      this.pendingPeerLookups.delete(hostId);
      pendingLookup.resolve(false);
    }
    this.syncedPeerSources.delete(hostId);
    this.peerTreeRetryAttempts.delete(hostId);
    this.clearPeerChangeTimer(hostId);
    this.clearPeerInteractions(hostId);
    const host = this.hosts.get(hostId);
    if (host) host.online = false;
    for (const entry of this.entries.values()) {
      if (entry.identity.hostId === hostId) this.offline(entry);
    }
    this.publishDraftSummaries(hostId);
    this.syncGroups();
  }
  private handlePeerReset(hostId: string, epoch: string, full: boolean): void {
    if (this.closed) return;
    const synced = this.syncedPeerSources.get(hostId);
    if (synced && (full || synced.epoch !== epoch)) {
      this.syncedPeerSources.delete(hostId);
    }
    this.peerTreeRetryAttempts.delete(hostId);
    const hostEpoch = this.hosts.get(hostId)?.epoch;
    let epochChanged = hostEpoch !== undefined && hostEpoch !== epoch;
    for (const [id, entry] of this.entries) {
      if (entry.identity.hostId !== hostId) continue;
      if (entry.epoch && entry.epoch !== epoch) {
        epochChanged = true;
        const beforeSummary = JSON.stringify(this.summary(id, entry));
        this.clearPending(id);
        this.retireView(entry);
        delete entry.controls;
        delete entry.peerInspected;
        delete entry.peerTreeParent;
        entry.epoch = epoch;
        const afterSummary = this.summary(id, entry);
        if (JSON.stringify(afterSummary) !== beforeSummary) {
          this.syncPeerCatalogProjections(id, entry, afterSummary);
          this.events.emit("api-session/added", afterSummary);
        }
      }
    }
    if (full || epochChanged) {
      this.clearPeerInteractions(hostId);
      for (const entry of this.entries.values()) {
        if (entry.identity.hostId === hostId) {
          entry.view?.log.setProjection("nativeInteractionError", null);
        }
      }
      this.peerResetRevisions.set(hostId, (this.peerResetRevisions.get(hostId) ?? 0) + 1);
    }
  }
  private peerEndpoint(hostId: string): PeerAttachmentEndpoint | undefined {
    if (!hostId.startsWith(REMOTE_PEER_HOST_ID_PREFIX)) return undefined;
    return this.peers?.client?.(hostId);
  }
  private peerAttachmentsSupported(hostId: string): boolean {
    return this.attachments.supported(this.peerEndpoint(hostId));
  }
  private peerWorkspaceFilesSupported(hostId: string): boolean {
    const peer = this.peerEndpoint(hostId);
    return peer?.state === "connected" && peer.manifest?.capabilities?.workspaceFiles === 1;
  }
  private peerOfficePreviewSupported(hostId: string): boolean {
    const peer = this.peerEndpoint(hostId);
    return (
      peer?.state === "connected" &&
      peer.manifest?.capabilities?.workspaceFiles === 1 &&
      peer.manifest?.capabilities?.officePreview === 1
    );
  }
  resolveDraftCanonicalId(sessionId: string): {
    readonly isDraft: boolean;
    readonly canonicalId?: string;
    readonly hostId?: string;
  } {
    const draft = this.drafts.get(sessionId);
    if (!draft) return { isDraft: false };
    return {
      isDraft: true,
      ...(draft.canonicalId !== undefined ? { canonicalId: draft.canonicalId } : {}),
      hostId: draft.target.hostId,
    };
  }
  peerClient(hostId: string): PeerAttachmentEndpoint | undefined {
    return this.peerEndpoint(hostId);
  }
  private draftOnline(hostId: string): boolean {
    const host = this.hosts.get(hostId);
    if (host !== undefined) return host.online;
    const peer = this.peerEndpoint(hostId);
    if (peer !== undefined) return peer.state === "connected";
    return true;
  }
  private draftSummary(draft: RemoteProjectDraft) {
    const online = this.draftOnline(draft.target.hostId);
    return draft.summary(
      online && this.peerAttachmentsSupported(draft.target.hostId),
      this.hosts.get(draft.target.hostId)?.color,
      online,
    );
  }
  private publishDraftSummaries(hostId?: string): void {
    if (this.closed) return;
    for (const draft of this.drafts.values()) {
      if (draft.canonicalId) continue;
      if (hostId !== undefined && draft.target.hostId !== hostId) continue;
      const summary = this.draftSummary(draft);
      this.events.emit("api-session/added", summary);
      for (const sink of this.controls) {
        sink.push({
          type: "projection",
          sessionId: draft.id,
          key: "remoteHost",
          value: summary.projections.values.remoteHost,
          seq: 0,
        });
        sink.push({
          type: "projection",
          sessionId: draft.id,
          key: "attachmentInput",
          value: summary.projections.values.attachmentInput,
          seq: 0,
        });
      }
    }
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
  private backgroundRefreshPending = false;
  private pendingHostIds = new Set<string>();
  private pendingPeerLookups = new Map<string, PromiseWithResolvers<boolean>>();
  private syncedPeerSources = new Map<
    string,
    { source: PeerThreadSource; epoch: string | undefined; listedAt: number }
  >();
  private inFlightPeerSources = new Map<string, PeerThreadSource>();
  private peerChangeTimers = new Map<string, NodeJS.Timeout>();
  private peerTreeRetryAttempts = new Map<string, number>();
  private peerResetRevisions = new Map<string, number>();
  private clearPeerChangeTimer(hostId: string): void {
    const timer = this.peerChangeTimers.get(hostId);
    if (!timer) return;
    clearTimeout(timer);
    this.peerChangeTimers.delete(hostId);
  }
  private schedulePeerTreeRetry(hostId: string): void {
    if (this.closed || this.peerChangeTimers.has(hostId)) return;
    const attempt = this.peerTreeRetryAttempts.get(hostId) ?? 0;
    this.peerTreeRetryAttempts.set(hostId, attempt + 1);
    const delay = Math.min(PEER_CATALOG_REFRESH_MIN_INTERVAL_MS * 2 ** attempt, 30_000);
    const timer = setTimeout(() => {
      this.peerChangeTimers.delete(hostId);
      if (this.closed) return;
      this.queueHostRefresh(hostId);
    }, delay);
    timer.unref();
    this.peerChangeTimers.set(hostId, timer);
  }
  private isPeerSynced(host: RemoteWorkspaceHost, source: PeerThreadSource): boolean {
    const synced = this.syncedPeerSources.get(host.hostId);
    return (
      synced !== undefined &&
      synced.source === source &&
      (host.epoch === undefined || synced.epoch === host.epoch)
    );
  }
  private hasPendingRefresh(): boolean {
    return (
      this.refreshPending ||
      this.fullRefreshPending ||
      this.backgroundRefreshPending ||
      this.pendingHostIds.size > 0
    );
  }
  private deferPeerLookup(hostId: string, lookup: PromiseWithResolvers<boolean>): void {
    if (this.closed) {
      lookup.resolve(false);
      return;
    }
    const existing = this.pendingPeerLookups.get(hostId);
    if (existing) {
      void existing.promise.then((confirmed) => lookup.resolve(confirmed));
    } else {
      this.pendingPeerLookups.set(hostId, lookup);
    }
    this.pendingHostIds.add(hostId);
    this.refreshPending = true;
  }
  private startRefresh(): Promise<void> {
    if (this.listing) return this.listing;
    if (this.archiveWrites) {
      this.refreshPending = true;
      return Promise.resolve();
    }
    // Lookups queued during an active refresh belong to the next batch.
    const peerLookups = this.pendingPeerLookups;
    this.pendingPeerLookups = new Map();
    this.listing = this.list(peerLookups).finally(() => {
      // Hosts skipped by discovery and incomplete reads cannot confirm absence.
      for (const lookup of peerLookups.values()) lookup.resolve(false);
      this.listing = undefined;
      if (!this.closed && !this.archiveWrites && this.hasPendingRefresh()) {
        this.refreshPending = false;
        void this.startRefresh().catch(() => undefined);
      }
    });
    return this.listing;
  }
  private queueHostRefresh(hostId: string): void {
    this.clearPeerChangeTimer(hostId);
    this.pendingHostIds.add(hostId);
    if (this.listing || this.archiveWrites) {
      this.refreshPending = true;
      return;
    }
    void this.startRefresh().catch(() => undefined);
  }
  hostsChanged(hostId?: string): void {
    if (this.closed) return;
    if (!hostId) {
      for (const id of [...this.peerChangeTimers.keys()]) this.clearPeerChangeTimer(id);
      this.fullRefreshPending = true;
      if (this.listing || this.archiveWrites) {
        this.refreshPending = true;
        return;
      }
      void this.startRefresh().catch(() => undefined);
      return;
    }
    const peerSource = this.peers?.source(hostId);
    if (!peerSource) {
      this.syncedPeerSources.delete(hostId);
      this.queueHostRefresh(hostId);
      return;
    }
    const synced = this.syncedPeerSources.get(hostId);
    const sameSynced = synced !== undefined && synced.source === peerSource;
    const inFlight = this.inFlightPeerSources.get(hostId) === peerSource;
    const elapsed = sameSynced
      ? Date.now() - synced.listedAt
      : PEER_CATALOG_REFRESH_MIN_INTERVAL_MS;
    if (inFlight || (sameSynced && elapsed < PEER_CATALOG_REFRESH_MIN_INTERVAL_MS)) {
      if (this.peerChangeTimers.has(hostId)) return;
      const delay = inFlight
        ? PEER_CATALOG_REFRESH_MIN_INTERVAL_MS
        : Math.max(50, PEER_CATALOG_REFRESH_MIN_INTERVAL_MS - elapsed);
      const timer = setTimeout(() => {
        this.peerChangeTimers.delete(hostId);
        if (this.closed) return;
        this.queueHostRefresh(hostId);
      }, delay);
      timer.unref();
      this.peerChangeTimers.set(hostId, timer);
      return;
    }
    this.queueHostRefresh(hostId);
  }
  private refreshBackground(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.backgroundRefreshPending = true;
    if (this.archiveWrites) {
      this.refreshPending = true;
      return this.listing ?? Promise.resolve();
    }
    return this.startRefresh();
  }
  refresh(hostId?: string): Promise<void> {
    if (hostId) {
      this.clearPeerChangeTimer(hostId);
      this.pendingHostIds.add(hostId);
    } else {
      for (const id of [...this.peerChangeTimers.keys()]) this.clearPeerChangeTimer(id);
      this.fullRefreshPending = true;
    }
    if (this.archiveWrites) {
      this.refreshPending = true;
      return this.listing ?? Promise.resolve();
    }
    return this.startRefresh();
  }
  private async list(peerLookups: Map<string, PromiseWithResolvers<boolean>>): Promise<void> {
    if (this.archiveWrites) {
      for (const [hostId, lookup] of peerLookups) {
        this.deferPeerLookup(hostId, lookup);
      }
      peerLookups.clear();
      return;
    }
    const explicitFullRefresh =
      this.fullRefreshPending || (!this.backgroundRefreshPending && this.pendingHostIds.size === 0);
    const backgroundRefresh = this.backgroundRefreshPending;
    const dirtyHosts = new Set(this.pendingHostIds);
    this.fullRefreshPending = false;
    this.backgroundRefreshPending = false;
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
      for (const hostId of this.peerInteractions.keys()) this.clearPeerInteractions(hostId);
      for (const entry of this.entries.values()) this.offline(entry);
      for (const host of this.hosts.values()) host.online = false;
      this.syncedPeerSources.clear();
      this.publishDraftSummaries();
      this.syncGroups();
      return;
    }
    const previousHosts = this.hosts;
    this.hosts = new Map(hosts.map((host) => [host.hostId, host]));
    for (const [hostId, lookup] of peerLookups) {
      if (!this.hosts.get(hostId)?.online || !this.peers?.source(hostId)) lookup.resolve(false);
    }
    const metadataChangedHostIds = new Set<string>();
    const draftChangedHostIds = new Set<string>();
    for (const host of hosts) {
      const prev = previousHosts.get(host.hostId);
      if (
        prev !== undefined &&
        (prev.displayName !== host.displayName || prev.color !== host.color)
      ) {
        metadataChangedHostIds.add(host.hostId);
        draftChangedHostIds.add(host.hostId);
      } else if (prev !== undefined && prev.online !== host.online) {
        draftChangedHostIds.add(host.hostId);
      }
    }
    if (metadataChangedHostIds.size > 0) {
      for (const [id, entry] of this.entries) {
        if (!metadataChangedHostIds.has(entry.identity.hostId)) continue;
        const nextSummary = this.summary(id, entry);
        entry.view?.log.setProjection("remoteHost", nextSummary.projections.values.remoteHost);
        this.events.emit("api-session/added", nextSummary);
      }
    }
    for (const hostId of draftChangedHostIds) {
      this.publishDraftSummaries(hostId);
    }
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
    for (const hostId of [...this.peerInteractions.keys()]) {
      if (!this.hosts.has(hostId)) this.clearPeerInteractions(hostId, true);
    }
    for (const hostId of [...this.syncedPeerSources.keys()]) {
      const host = this.hosts.get(hostId);
      const peerSource = this.peers?.source(hostId);
      if (!host || !host.online || !peerSource || !this.isPeerSynced(host, peerSource)) {
        this.syncedPeerSources.delete(hostId);
      }
    }
    for (const hostId of [...this.peerChangeTimers.keys()]) {
      const host = this.hosts.get(hostId);
      if (!host || !host.online || !this.peers?.source(hostId)) {
        this.clearPeerChangeTimer(hostId);
        this.peerTreeRetryAttempts.delete(hostId);
      }
    }
    for (const hostId of [...this.peerTreeRetryAttempts.keys()]) {
      const host = this.hosts.get(hostId);
      if (!host || !host.online || !this.peers?.source(hostId)) {
        this.peerTreeRetryAttempts.delete(hostId);
      }
    }
    const present = new Set(hosts.filter((host) => host.online).map((host) => host.hostId));
    for (const hostId of this.peerInteractions.keys()) {
      if (!present.has(hostId)) this.clearPeerInteractions(hostId);
    }
    for (const entry of this.entries.values())
      if (!present.has(entry.identity.hostId)) this.offline(entry);
    // Publish updated host states and manifest project folders immediately instead of
    // leaving the UI on a stale `connecting` placeholder while multi-page catalog reads run.
    this.syncGroups();
    await Promise.all(
      hosts
        .filter((host) => {
          if (!host.online) return false;
          if (
            explicitFullRefresh ||
            dirtyHosts.has(host.hostId) ||
            !previouslyOnline.has(host.hostId)
          )
            return true;
          if (!backgroundRefresh) return false;
          const peerSource = this.peers?.source(host.hostId);
          return !(peerSource && this.isPeerSynced(host, peerSource));
        })
        .map(async (host) => {
          const peerSource = this.peers?.source(host.hostId);
          if (peerSource) {
            const outcome = await this.listPeerHost(host, peerSource, archiveRevision);
            this.syncGroups();
            const lookup = peerLookups.get(host.hostId);
            if (lookup) {
              peerLookups.delete(host.hostId);
              if (outcome === "superseded") {
                this.deferPeerLookup(host.hostId, lookup);
              } else {
                lookup.resolve(outcome === "confirmed");
              }
            }
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
  private reserveRetiredProjectionSeq(entry: Entry): number | undefined {
    if (entry.view || entry.viewOrigin === undefined) return undefined;
    const seq = entry.viewOrigin - 1;
    entry.viewOrigin = seq + 2;
    return seq;
  }
  private peerCatalogProjectionEntries(
    entry: Entry,
    nextSummary: ReturnType<RemoteSessions["summary"]>,
  ): Array<[string, unknown]> {
    const entries: Array<[string, unknown]> = [
      ["title", nextSummary.projections.values.title],
      ["remoteHost", nextSummary.projections.values.remoteHost],
      ["nativeDiscovery", nextSummary.projections.values.nativeDiscovery],
      ["attachmentInput", nextSummary.projections.values.attachmentInput],
    ];
    if ("imageLimits" in nextSummary.projections.values) {
      entries.push(["imageLimits", nextSummary.projections.values.imageLimits]);
    }
    if (entry.peerOwnershipAvailable && entry.peerTreeParent !== undefined) {
      entries.push(["threadTreeParent", entry.peerTreeParent]);
    } else if (entry.hadPeerTreeParent) {
      entries.push(["threadTreeParent", null]);
    }
    return entries;
  }
  private captureCatalogFingerprints(projections: Record<string, unknown>): Map<string, string> {
    const fingerprints = new Map<string, string>();
    for (const key of [
      "title",
      "remoteHost",
      "nativeDiscovery",
      "attachmentInput",
      "imageLimits",
      "threadTreeParent",
    ]) {
      if (Object.hasOwn(projections, key)) {
        fingerprints.set(key, JSON.stringify(projections[key]) ?? "undefined");
      }
    }
    return fingerprints;
  }
  private syncPeerCatalogProjections(
    id: string,
    entry: Entry,
    nextSummary: ReturnType<RemoteSessions["summary"]>,
  ): void {
    const updates = this.peerCatalogProjectionEntries(entry, nextSummary);
    if (entry.view) {
      for (const [key, value] of updates) {
        entry.view.log.setProjection(key, value);
      }
      if (entry.peerHarnessIdentity && !entry.controls?.harness) {
        entry.view.log.setProjection("harnessIdentity", entry.peerHarnessIdentity);
      }
      return;
    }
    if (entry.viewOrigin === undefined) return;
    const previous = entry.retiredCatalogProjections ?? new Map<string, string>();
    const changed: Array<[string, unknown]> = [];
    const nextFingerprints = new Map(previous);
    for (const [key, value] of updates) {
      const fingerprint = JSON.stringify(value) ?? "undefined";
      if (previous.get(key) !== fingerprint) {
        changed.push([key, value]);
        nextFingerprints.set(key, fingerprint);
      }
    }
    entry.retiredCatalogProjections = nextFingerprints;
    if (changed.length === 0 || this.controls.size === 0) return;
    // A previously opened Peer Thread retains sequenced browser projections after view
    // retirement; push only changed catalog projections above its retired sequence watermark.
    const seq = this.reserveRetiredProjectionSeq(entry);
    if (seq === undefined) return;
    for (const [key, value] of changed) {
      for (const sink of this.controls) {
        sink.push({ type: "projection", sessionId: id, key, value, seq });
      }
    }
  }
  private replayPeerControlProjections(sink: StreamSink): void {
    for (const [id, entry] of this.entries) {
      if (sink.closed) break;
      if (!entry.identity.hostId.startsWith(REMOTE_PEER_HOST_ID_PREFIX)) continue;
      if (entry.view) {
        const seq = Math.max(entry.view.log.lastSeq, 0);
        for (const [key, value] of this.peerCatalogProjectionEntries(
          entry,
          this.summary(id, entry),
        )) {
          sink.push({ type: "projection", sessionId: id, key, value, seq });
        }
        continue;
      }
      if (entry.viewOrigin === undefined) continue;
      const seq = this.reserveRetiredProjectionSeq(entry);
      if (seq === undefined) continue;
      const entries = this.peerCatalogProjectionEntries(entry, this.summary(id, entry));
      const fingerprints = entry.retiredCatalogProjections ?? new Map<string, string>();
      for (const [key, value] of entries) {
        fingerprints.set(key, JSON.stringify(value) ?? "undefined");
        sink.push({ type: "projection", sessionId: id, key, value, seq });
      }
      entry.retiredCatalogProjections = fingerprints;
    }
  }
  private async listPeerHost(
    host: RemoteWorkspaceHost,
    source: PeerThreadSource,
    archiveRevision: number,
  ): Promise<"confirmed" | "superseded" | "failed"> {
    const canRetrySuperseded = (): "superseded" | "failed" => {
      const peer = this.peerEndpoint(host.hostId);
      return !this.closed &&
        this.peers?.source(host.hostId) === source &&
        (peer === undefined || peer.state === "connected")
        ? "superseded"
        : "failed";
    };
    const unlisted = new Set(
      [...this.entries.values()].filter(
        (entry) => entry.identity.hostId === host.hostId && entry.createdEpoch,
      ),
    );
    const startGeneration = source.generation;
    const startResetRevision = this.peerResetRevisions.get(host.hostId) ?? 0;
    const startHostEpoch = host.epoch;
    const isCurrentList = () =>
      !this.closed &&
      archiveRevision === this.archiveRevision &&
      this.peers?.source(host.hostId) === source &&
      source.generation === startGeneration &&
      (this.peerResetRevisions.get(host.hostId) ?? 0) === startResetRevision &&
      (startHostEpoch === undefined ||
        this.hosts.get(host.hostId)?.epoch === undefined ||
        this.hosts.get(host.hostId)?.epoch === startHostEpoch);
    this.inFlightPeerSources.set(host.hostId, source);
    // Warm plugin metadata/icons in parallel with catalog paging so harness names
    // and sidebar logos are ready as soon as page 1 renders, without blocking list commit.
    void source.catalog
      .list()
      .then(() => {
        if (this.closed || this.peers?.source(host.hostId) !== source) return;
        // Read the generation-guarded cached list so a late pre-invalidation response never overwrites newer names.
        const currentPlugins = source.catalog.cachedList();
        if (!currentPlugins) return;
        const names = new Map<string, string>(
          currentPlugins.map((plugin) => [plugin.id, plugin.name]),
        );
        for (const [id, entry] of this.entries) {
          if (entry.identity.hostId !== host.hostId || !entry.peerHarnessIdentity) continue;
          const resolvedName = names.get(entry.peerHarnessIdentity.id);
          if (!resolvedName || resolvedName === entry.peerHarnessIdentity.name) continue;
          entry.peerHarnessIdentity = { id: entry.peerHarnessIdentity.id, name: resolvedName };
          const nextSummary = this.summary(id, entry);
          entry.view?.log.setProjection("harnessIdentity", entry.peerHarnessIdentity);
          this.events.emit("api-session/added", nextSummary);
        }
      })
      .catch(() => undefined);
    try {
      const listed = await source.listThreads({
        onPage: (partial) => {
          if (!isCurrentList()) {
            return;
          }
          const cachedPlugins = source.catalog.cachedList();
          const cachedNames = new Map<string, string>(
            cachedPlugins?.map((plugin) => [plugin.id, plugin.name]),
          );
          let published = false;
          for (const row of partial.rows) {
            const id = remoteSessionId(host.hostId, row.id);
            const harnessId = partial.harnessIds.get(row.id);
            const peerHarnessIdentity = harnessId
              ? {
                  id: harnessId,
                  name: harnessId === "codex" ? "Codex" : (cachedNames.get(harnessId) ?? harnessId),
                }
              : undefined;
            const previous = this.entries.get(id);
            const beforeSummary = previous ? JSON.stringify(this.summary(id, previous)) : undefined;
            if (previous && host.epoch && previous.epoch && previous.epoch !== host.epoch) {
              this.clearPending(id);
              this.retireView(previous, source);
              delete previous.controls;
              delete previous.peerInspected;
              delete previous.peerTreeParent;
            }
            const current: Entry = previous
              ? Object.assign(previous, {
                  row: { ...row, turns: [] },
                  online: true,
                  archived: partial.archivedIds.has(row.id),
                  peerOwnershipAvailable: partial.ownershipAvailable,
                  ...(host.epoch ? { epoch: host.epoch } : {}),
                })
              : {
                  identity: { hostId: host.hostId, threadId: row.id },
                  row: { ...row, turns: [] },
                  online: true,
                  archived: partial.archivedIds.has(row.id),
                  ...(host.epoch ? { epoch: host.epoch } : {}),
                  configurationRevision: 0,
                  peerOwnershipAvailable: partial.ownershipAvailable,
                };
            if (peerHarnessIdentity) current.peerHarnessIdentity = peerHarnessIdentity;
            if (partial.ownershipAvailable && Object.hasOwn(partial.parents, row.id)) {
              const nativeParent = partial.parents[row.id];
              current.peerTreeParent =
                nativeParent && nativeParent !== row.id
                  ? remoteSessionId(host.hostId, nativeParent)
                  : null;
              if (current.peerTreeParent !== null) current.hadPeerTreeParent = true;
            }
            this.entries.set(id, current);
            const nextSummary = this.summary(id, current);
            if (beforeSummary !== JSON.stringify(nextSummary)) {
              this.syncPeerCatalogProjections(id, current, nextSummary);
              this.events.emit("api-session/added", nextSummary);
              published = true;
            }
          }
          if (published) this.syncGroups();
        },
      });
      const cachedPlugins = source.catalog.cachedList();
      const harnessNames = new Map<string, string>(
        cachedPlugins?.map((plugin) => [plugin.id, plugin.name]),
      );
      harnessNames.set("codex", "Codex");
      if (!isCurrentList() || listed.stale) {
        return canRetrySuperseded();
      }
      const prevArchivedIds = this.peerArchivedIds.get(host.hostId);
      const nextArchivedIds = new Set(listed.archivedIds);
      if (listed.unarchivedIds) {
        for (const threadId of listed.unarchivedIds) {
          nextArchivedIds.delete(threadId);
        }
      }
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
        const explicitlyUnarchived = listed.unarchivedIds?.has(row.id) === true;
        const retainedBackfill =
          !explicitlyUnarchived && listed.retainedAncestorIds?.has(row.id) === true;
        const previousArchived =
          retainedBackfill &&
          (this.entries.get(id)?.archived === true || prevArchivedIds?.has(row.id) === true);
        const archived = !explicitlyUnarchived && (nextArchivedIds.has(row.id) || previousArchived);
        if (archived) nextArchivedIds.add(row.id);
        found.set(id, {
          identity: { hostId: host.hostId, threadId: row.id },
          row: { ...row, turns: [] },
          online: true,
          archived,
          ...(host.epoch ? { epoch: host.epoch } : {}),
          configurationRevision: 0,
          peerOwnershipAvailable: listed.ownershipAvailable,
          ...(peerHarnessIdentity ? { peerHarnessIdentity } : {}),
          ...(peerTreeParent !== undefined ? { peerTreeParent } : {}),
        });
      }
      const restoredMissingEntries = new Set<string>();
      if (listed.unarchivedIds) {
        for (const threadId of listed.unarchivedIds) {
          const id = remoteSessionId(host.hostId, threadId);
          const existing = this.entries.get(id);
          if (existing?.archived) {
            existing.archived = false;
            if (!found.has(id)) restoredMissingEntries.add(id);
          }
        }
      }
      if (prevArchivedIds) {
        for (const threadId of prevArchivedIds) {
          if (listed.unarchivedIds?.has(threadId)) continue;
          const id = remoteSessionId(host.hostId, threadId);
          const existing = this.entries.get(id);
          const listedActive = found.has(id) && !found.get(id)?.archived;
          if (!listedActive && existing?.archived) {
            nextArchivedIds.add(threadId);
          }
        }
      }
      this.peerArchivedIds.set(host.hostId, nextArchivedIds);
      for (const [id, entry] of this.entries) {
        if (entry.identity.hostId === host.hostId && !found.has(id) && !entry.archived) {
          if (listed.unarchivedIds?.has(entry.identity.threadId)) {
            if (restoredMissingEntries.has(id) || !entry.online) {
              entry.online = true;
              this.events.emit("api-session/added", this.summary(id, entry));
            }
            continue;
          }
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
          if (entry.peerTreeParent !== null) current.hadPeerTreeParent = true;
        } else {
          delete current.peerTreeParent;
        }
        this.entries.set(id, current);
        delete current.createdEpoch;
        const nextSummary = this.summary(id, current);
        const summaryChanged = beforeSummary !== JSON.stringify(nextSummary);
        this.syncPeerCatalogProjections(id, current, nextSummary);
        if (summaryChanged) {
          this.events.emit("api-session/added", nextSummary);
        }
      }
      this.syncArchives();
      if (listed.treeStale) {
        this.syncedPeerSources.delete(host.hostId);
        this.schedulePeerTreeRetry(host.hostId);
        return "failed";
      }
      this.peerTreeRetryAttempts.delete(host.hostId);
      this.syncedPeerSources.set(host.hostId, {
        source,
        epoch: host.epoch,
        listedAt: Date.now(),
      });
      return "confirmed";
    } catch {
      if (!isCurrentList()) return canRetrySuperseded();
      this.syncedPeerSources.delete(host.hostId);
      this.clearPeerInteractions(host.hostId);
      host.online = false;
      for (const entry of this.entries.values()) {
        if (entry.identity.hostId === host.hostId) this.offline(entry);
      }
      this.publishDraftSummaries(host.hostId);
      return "failed";
    } finally {
      if (this.inFlightPeerSources.get(host.hostId) === source) {
        this.inFlightPeerSources.delete(host.hostId);
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
    const workspaceFilesSupported =
      entry.online && this.peerWorkspaceFilesSupported(entry.identity.hostId);
    const officePreviewSupported =
      entry.online && this.peerOfficePreviewSupported(entry.identity.hostId);
    const nativeDiscovery =
      entry.identity.hostId.startsWith(REMOTE_PEER_HOST_ID_PREFIX) &&
      !entry.row.parentThreadId &&
      entry.row.canAcceptDirectInput !== false;
    const harnessIdentity =
      remoteHarnessIdentity(entry) ??
      (entry.row.modelProvider !== "codexhost" ? { id: "codex", name: "Codex" } : undefined);
    const host = this.hosts.get(entry.identity.hostId);
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
            displayName: remoteHostDisplayName(host ?? { hostId: entry.identity.hostId }),
            state: entry.online ? "connected" : "disconnected",
            ...(host?.color !== undefined ? { color: host.color } : {}),
            filePreview: attachmentsSupported,
            workspaceFiles: workspaceFilesSupported,
            officePreview: officePreviewSupported,
          },
          ...(harnessIdentity ? { harnessIdentity } : {}),
          ...(entry.peerOwnershipAvailable && entry.peerTreeParent !== undefined
            ? { threadTreeParent: entry.peerTreeParent }
            : entry.hadPeerTreeParent
              ? { threadTreeParent: null }
              : {}),
          threadReference: this.reference(entry),
          nativeConnection: { state: entry.online ? "connected" : "reconnecting" },
          nativeDiscovery,
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
    entry.view?.log.setProjection("nativeInteractionError", null);
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
  private interactionsForPeer(hostId: string, source: PeerThreadSource): ChInteractions {
    const realtime = source.host.realtime;
    const existing = this.peerInteractions.get(hostId);
    if (existing && existing.realtime === realtime) return existing.interactions;
    existing?.interactions.clear();
    const interactions = new ChInteractions(realtime, this.events, (sessionId, message) => {
      this.entries.get(sessionId)?.view?.log.setProjection("nativeInteractionError", message);
    });
    this.peerInteractions.set(hostId, { realtime, interactions });
    return interactions;
  }
  private clearPeerInteractions(hostId: string, remove = false): void {
    const existing = this.peerInteractions.get(hostId);
    if (!existing) return;
    existing.interactions.clear();
    if (remove) this.peerInteractions.delete(hostId);
  }
  private clearPending(id: string): void {
    for (const [key, item] of this.pending)
      if (item.sessionId === id) {
        this.pending.delete(key);
        item.cancel();
      }
    let hostId = this.entries.get(id)?.identity.hostId;
    if (!hostId) {
      try {
        hostId = remoteSessionIdentity(id)?.hostId;
      } catch {
        hostId = undefined;
      }
    }
    if (hostId) this.peerInteractions.get(hostId)?.interactions.clearSession(id);
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
    const startResetRevision = this.peerResetRevisions.get(current.identity.hostId) ?? 0;
    current.reading ??= (async () => {
      try {
        const before = JSON.stringify(this.summary(id, current));
        const MAX_VIEW_REBUILDS = 4;
        let history: ChThreadHistory;
        let refreshForce = force;
        let rebuilds = 0;
        let originAdvancedDuringRead = false;
        for (;;) {
          const startOrigin = current.viewOrigin;
          history = source.history(current.identity.threadId, id, startOrigin, {
            row: current.row,
            harnessId: viewHarnessId(current),
            onProjection: this.controlProjectionListener,
          });
          try {
            await history.refresh(refreshForce);
          } catch (error) {
            if (
              !(error instanceof RpcError) ||
              !["host/history-changed", "host/items-replaced"].includes(error.code)
            ) {
              throw error;
            }
            if (current.view) {
              this.retireView(current, source);
            } else {
              current.viewOrigin = Math.max(current.viewOrigin ?? 0, history.log.lastSeq + 2);
              source.discard(current.identity.threadId);
              history.retire();
            }
            if (++rebuilds > MAX_VIEW_REBUILDS) {
              throw new RpcError(
                "remote/connection-changed",
                "Remote Thread history changed repeatedly during read",
              );
            }
            refreshForce = true;
            continue;
          }
          requireCurrent();
          // Retired catalog projections or control reconnect replays may advance `viewOrigin`
          // while this snapshot is in flight. Rebuild only when the loaded history tail falls
          // below the reserved floor (`viewOrigin - 1`); if the loaded turns already reached
          // or exceeded that floor, reuse this snapshot and rebroadcast catalog projections at
          // `history.log.lastSeq` below.
          if (
            current.view !== history &&
            current.viewOrigin !== undefined &&
            history.log.lastSeq < current.viewOrigin - 1
          ) {
            source.discard(current.identity.threadId);
            history.retire();
            if (++rebuilds > MAX_VIEW_REBUILDS) {
              throw new RpcError(
                "remote/connection-changed",
                "Remote Thread sequence watermark advanced repeatedly during history read",
              );
            }
            refreshForce = true;
            continue;
          }
          originAdvancedDuringRead =
            current.view !== history &&
            current.viewOrigin !== undefined &&
            current.viewOrigin !== startOrigin;
          break;
        }
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
        delete current.retiredCatalogProjections;
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
          if (
            configurationRevision !== current.configurationRevision ||
            current.view !== history ||
            !current.online ||
            this.peers?.source(current.identity.hostId) !== source ||
            (this.peerResetRevisions.get(current.identity.hostId) ?? 0) !== startResetRevision
          ) {
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
        if (originAdvancedDuringRead && this.controls.size > 0) {
          const tailSeq = Math.max(history.log.lastSeq, 0);
          for (const [key, value] of this.peerCatalogProjectionEntries(current, summary)) {
            for (const sink of this.controls) {
              sink.push({ type: "projection", sessionId: id, key, value, seq: tailSeq });
            }
          }
        }
        applyRemoteControls(current, history);
        if (current.epoch) this.loadUsage(id, current, history, current.epoch);
        if (
          snapshot &&
          !this.closed &&
          current.online &&
          current.view === history &&
          this.peers?.source(current.identity.hostId) === source &&
          (!current.epoch || current.epoch === snapshot.cursor.epoch) &&
          (this.peerResetRevisions.get(current.identity.hostId) ?? 0) === startResetRevision
        ) {
          this.interactionsForPeer(current.identity.hostId, source).update(snapshot, id);
        }
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
        source.setArchived(memberId, archived);
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
    entry.viewOrigin = Math.max(entry.viewOrigin ?? 0, entry.view.log.lastSeq + 2);
    entry.retiredCatalogProjections = this.captureCatalogFingerprints(entry.view.log.projections);
    if (typeof entry.view.log.projections.threadTreeParent === "string") {
      entry.hadPeerTreeParent = true;
    }
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
  private async lookupPeerSummary(id: string, hostId: string): Promise<Entry | undefined> {
    if (this.peerEndpoint(hostId)?.state === "connecting") {
      await this.peers?.waitForInitialConnection?.(hostId);
    }
    const source = this.peers?.source(hostId);
    if (!source) return undefined;

    const requireOnline = () => {
      const peer = this.peerEndpoint(hostId);
      if (this.closed || (peer && peer.state !== "connected"))
        throw new RpcError("remote/offline", "Remote peer is not connected");
      return peer?.manifest?.epoch;
    };
    const epoch = requireOnline();
    const entry = this.entries.get(id);
    const host = this.hosts.get(hostId);
    if (
      entry?.online &&
      host?.online &&
      (epoch === undefined || host.epoch === epoch) &&
      this.isPeerSynced(host, source)
    )
      return entry;

    for (let attempt = 0; attempt < 2; attempt++) {
      let lookup = this.pendingPeerLookups.get(hostId);
      if (!lookup) {
        lookup = Promise.withResolvers<boolean>();
        this.pendingPeerLookups.set(hostId, lookup);
        this.queueHostRefresh(hostId);
      }
      const confirmed = await lookup.promise;
      const currentSource = this.peers?.source(hostId);
      if (!currentSource) return undefined;
      const currentEpoch = requireOnline();
      const currentHost = this.hosts.get(hostId);
      if (
        confirmed &&
        currentSource === source &&
        currentHost?.online &&
        (currentEpoch === undefined || currentHost.epoch === currentEpoch) &&
        this.isPeerSynced(currentHost, source)
      ) {
        return this.entries.get(id);
      }
      if (
        attempt === 0 &&
        confirmed &&
        currentSource === source &&
        currentHost?.online &&
        (currentEpoch === undefined || currentHost.epoch === currentEpoch)
      ) {
        continue;
      }
      throw new RpcError("remote/offline", "Remote peer catalog is unavailable");
    }
    throw new RpcError("remote/offline", "Remote peer catalog is unavailable");
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
          if (canonicalId.startsWith(`${PREFIX}draft-`))
            throw new RpcError("session/not-found", "Remote draft Session is no longer available.");
          const identity = remoteSessionIdentity(canonicalId);
          let entry: Entry | undefined;
          if (identity?.hostId.startsWith(REMOTE_PEER_HOST_ID_PREFIX)) {
            entry = await this.lookupPeerSummary(canonicalId, identity.hostId);
          } else {
            if (!this.entries.has(canonicalId)) await this.refresh();
            entry = this.entries.get(canonicalId);
          }
          if (!entry) throw new RpcError("remote/not-found", "Remote Thread not found");
          return {
            items: [this.summary(canonicalId, entry)],
            archivedSessionIds: this.syncArchives(),
          };
        }
        void this.refreshBackground().catch(() => undefined);
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
      if (method === "session/search") {
        return this.search(args, next);
      }
      const request = requestOf<{
        sessionId?: string;
        address?: { sessionId?: string };
        agentId?: string;
      }>(args);
      const id = request.sessionId ?? request.address?.sessionId ?? request.agentId ?? args.agentId;
      if (typeof id !== "string" || !id.startsWith(PREFIX)) return next();
      if (method === "fileReferences/list") return next();
      if (method === "commands/list") return [];
      if (method === "session/openWorkspacePath") {
        throw new RpcError(
          "session/open-unavailable",
          "Remote sessions cannot open files on the Hub host.",
        );
      }
      if (method === "codexhost/executeThreadCommand") {
        throw new RpcError(
          "remote/unsupported",
          "Direct command execution is unavailable for remote Threads.",
        );
      }
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
          case "codexhost/skills/list":
            return this.listDraftSkills(draft);
          case "codexhost/threadCommands":
            return this.inspectDraftCommands(draft);
          case "codexhost/turnDiffs": {
            const parsed = webTurnDiffsRequestSchema.safeParse(input);
            if (!parsed.success)
              throw new RpcError("session/diff-invalid", "Invalid Turn diff request.");
            throw new RpcError("session/diff-not-found", "This Turn is not loaded.");
          }
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
            ) {
              this.controls.add(sink);
              this.replayPeerControlProjections(sink);
            }
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
        const online = this.draftOnline(draft.target.hostId);
        draft.follow(
          sink,
          online && this.peerAttachmentsSupported(draft.target.hostId),
          this.hosts.get(draft.target.hostId)?.color,
          online,
        );
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
  private requireOnlinePeerSource(hostId: string): PeerThreadSource {
    if (this.closed) throw new RpcError("remote/offline", "Remote session gateway is closed");
    const host = this.hosts.get(hostId);
    if (host && !host.online) {
      throw new RpcError("remote/offline", "Remote peer is offline.");
    }
    const peer = this.peerEndpoint(hostId);
    if (peer && peer.state !== "connected") {
      throw new RpcError("remote/offline", "Remote peer is offline.");
    }
    const peerSource = this.peers?.source(hostId);
    if (!peerSource) {
      throw new RpcError("remote/offline", "Remote peer is offline.");
    }
    return peerSource;
  }
  private async listDraftSkills(draft: RemoteProjectDraft): Promise<SkillsListResult> {
    if (!draft.target.hostId.startsWith(REMOTE_PEER_HOST_ID_PREFIX)) {
      throw new RpcError("skills/unavailable", "Skills are unavailable for this remote host.");
    }
    if (draft.selection?.provider === "codex") {
      throw new RpcError("skills/unavailable", "Codex uses its native Skills.");
    }
    const peerSource = this.requireOnlinePeerSource(draft.target.hostId);
    return peerSource.listSkills({ cwd: draft.target.cwd });
  }
  private async listThreadSkills(id: string): Promise<SkillsListResult> {
    const identity = remoteSessionIdentity(id);
    if (!identity) throw new RpcError("remote/identity-invalid", "Remote identity required");
    if (!identity.hostId.startsWith(REMOTE_PEER_HOST_ID_PREFIX)) {
      throw new RpcError("skills/unavailable", "Skills are unavailable for this remote host.");
    }
    let entry = this.entries.get(id);
    if (!entry) {
      await this.refresh(identity.hostId);
      entry = this.entries.get(id);
    }
    if (!entry) throw new RpcError("remote/not-found", "Remote Thread not found");
    if (!entry.online) throw new RpcError("remote/offline", "Remote peer is offline.");
    const peerSource = this.requireOnlinePeerSource(identity.hostId);
    if (entry.row.parentThreadId || entry.row.canAcceptDirectInput === false) {
      throw new RpcError("skills/unavailable", "Skills require an editable remote Thread.");
    }
    if (viewHarnessId(entry) === "codex") {
      throw new RpcError("skills/unavailable", "Codex uses its native Skills.");
    }
    return peerSource.listSkills({ threadId: hostThreadIdSchema.parse(identity.threadId) });
  }
  private async inspectDraftCommands(draft: RemoteProjectDraft): Promise<HarnessCommandCatalog> {
    if (!draft.target.hostId.startsWith(REMOTE_PEER_HOST_ID_PREFIX)) {
      throw new RpcError("command/unavailable", "Commands are unavailable for this remote host.");
    }
    if (draft.selection?.provider !== "codex") {
      return { commands: [] };
    }
    const peerSource = this.requireOnlinePeerSource(draft.target.hostId);
    return peerSource.inspectHarnessCommands("codex", draft.target.cwd);
  }
  private async inspectThreadCommands(id: string): Promise<HarnessCommandCatalog> {
    const identity = remoteSessionIdentity(id);
    if (!identity) throw new RpcError("remote/identity-invalid", "Remote identity required");
    if (!identity.hostId.startsWith(REMOTE_PEER_HOST_ID_PREFIX)) {
      throw new RpcError("command/unavailable", "Commands are unavailable for this remote host.");
    }
    let entry = this.entries.get(id);
    if (!entry) {
      await this.refresh(identity.hostId);
      entry = this.entries.get(id);
    }
    if (!entry) throw new RpcError("remote/not-found", "Remote Thread not found");
    if (!entry.online) throw new RpcError("remote/offline", "Remote peer is offline.");
    const peerSource = this.requireOnlinePeerSource(identity.hostId);
    if (entry.row.parentThreadId || entry.row.canAcceptDirectInput === false) {
      throw new RpcError("command/unavailable", "Commands require an editable remote Thread.");
    }
    return peerSource.inspectThreadCommands(identity.threadId);
  }
  private async search(
    args: Record<string, unknown>,
    next: () => Promise<unknown>,
  ): Promise<{ items: Array<{ sessionId: string; snippet: string }>; hasMore: boolean }> {
    const rawQuery = requestOf<{ query?: unknown }>(args).query;
    const needle = typeof rawQuery === "string" ? rawQuery.toLowerCase() : "";
    const local = (await next()) as {
      items?: Array<{ sessionId: string; snippet: string }>;
      hasMore?: boolean;
    };
    const localItems = Array.isArray(local?.items) ? local.items : [];
    const localHasMore = local?.hasMore === true;
    const seen = new Set(localItems.map((item) => item.sessionId));
    const remoteMatches: Array<{ sessionId: string; snippet: string; updatedAt: number }> = [];
    for (const [id, entry] of this.entries) {
      if (seen.has(id)) continue;
      const snippet = threadListTitle({ ...entry.row, id: entry.identity.threadId });
      if (snippet.toLowerCase().includes(needle)) {
        remoteMatches.push({ sessionId: id, snippet, updatedAt: entry.row.updatedAt * 1000 });
      }
    }
    for (const draft of this.drafts.values()) {
      if (draft.canonicalId || seen.has(draft.id)) continue;
      const values = this.draftSummary(draft).projections.values as Record<string, unknown>;
      const title = values.title;
      if (typeof title === "string" && title.trim() && title.toLowerCase().includes(needle)) {
        remoteMatches.push({ sessionId: draft.id, snippet: title, updatedAt: draft.lastUsed });
      }
    }
    remoteMatches.sort((a, b) => b.updatedAt - a.updatedAt);
    const limit = 20;
    if (localItems.length + remoteMatches.length <= limit) {
      return {
        items: [
          ...localItems,
          ...remoteMatches.map(({ sessionId, snippet }) => ({ sessionId, snippet })),
        ],
        hasMore: localHasMore,
      };
    }
    const localQuota = Math.min(
      localItems.length,
      Math.max(Math.floor(limit / 2), limit - remoteMatches.length),
    );
    const remoteQuota = Math.min(remoteMatches.length, limit - localQuota);
    return {
      items: [
        ...localItems.slice(0, localQuota),
        ...remoteMatches
          .slice(0, remoteQuota)
          .map(({ sessionId, snippet }) => ({ sessionId, snippet })),
      ],
      hasMore: true,
    };
  }
  private async handle(
    method: string,
    id: string,
    request: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === "codexhost/turnDiffs") {
      const parsed = webTurnDiffsRequestSchema.safeParse(request);
      if (!parsed.success) throw new RpcError("session/diff-invalid", "Invalid Turn diff request.");
      const view = this.entries.get(id)?.view ?? (await this.read(id));
      return { diffs: view.turnDiffs(parsed.data.turn, parsed.data.path) };
    }
    if (method === "codexhost/skills/list") {
      return this.listThreadSkills(id);
    }
    if (method === "codexhost/threadCommands") {
      return this.inspectThreadCommands(id);
    }
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
      if (peerSource) {
        peerSource.setArchived(identity.threadId, false);
        this.peerArchivedIds.get(identity.hostId)?.delete(identity.threadId);
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
      if (peerSource) {
        peerSource.setArchived(entry.identity.threadId, operation.archived);
        const peerArchived = this.peerArchivedIds.get(entry.identity.hostId) ?? new Set<string>();
        if (operation.archived) peerArchived.add(entry.identity.threadId);
        else peerArchived.delete(entry.identity.threadId);
        this.peerArchivedIds.set(entry.identity.hostId, peerArchived);
      }
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
    for (const lookup of this.pendingPeerLookups.values()) lookup.resolve(false);
    this.pendingPeerLookups.clear();
    clearInterval(this.timer);
    for (const timer of this.peerChangeTimers.values()) clearTimeout(timer);
    this.peerChangeTimers.clear();
    this.peerTreeRetryAttempts.clear();
    this.peerResetRevisions.clear();
    this.syncedPeerSources.clear();
    this.inFlightPeerSources.clear();
    this.followLifetime.abort();
    if (this.peers) {
      if (this.peers.onThreadChanged === this.peerHandlers.onThreadChanged)
        delete this.peers.onThreadChanged;
      if (this.peers.onUsageChanged === this.peerHandlers.onUsageChanged)
        delete this.peers.onUsageChanged;
      if (this.peers.onCatalogInspectionChanged === this.peerHandlers.onCatalogInspectionChanged)
        delete this.peers.onCatalogInspectionChanged;
      if (this.peers.onSkillsChanged === this.peerHandlers.onSkillsChanged)
        delete this.peers.onSkillsChanged;
      if (this.peers.onConnection === this.peerHandlers.onConnection)
        delete this.peers.onConnection;
      if (this.peers.onReset === this.peerHandlers.onReset) delete this.peers.onReset;
    }
    for (const id of this.entries.keys()) this.clearPending(id);
    for (const peer of this.peerInteractions.values()) peer.interactions.clear();
    this.peerInteractions.clear();
    for (const entry of this.entries.values()) entry.view?.log.reconnectFollowers();
    this.peerArchivedIds.clear();
    this.controls.clear();
    this.drafts.clear();
    this.titleRequests.clear();
  }
}
