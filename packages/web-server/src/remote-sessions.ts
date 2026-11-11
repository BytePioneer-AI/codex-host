import { remoteApprovalPresentation } from "./remote-approval.ts";
import { requestRemoteSession } from "@codexhost/desktop-control";
import { z } from "zod";
import {
  remoteSessionOperationSchema,
  remoteSessionRequestBytes,
  REMOTE_CONTROLLER_REQUEST_MAX_BYTES,
  webToolOutputReferenceSchema,
  type RemoteSessionOperation,
} from "@codexhost/shared-contracts";
import { ChThreadView, type ChThread } from "./ch-thread-view.ts";
import { defaultProjections } from "./session-log.ts";
import { requestOf } from "./store.ts";
import {
  RpcError,
  type EventHub,
  type RpcRegistry,
  type StreamRegistry,
  type StreamSink,
} from "./transport.ts";
import { readToolOutput, toolOutputSink } from "./tool-output.ts";
import type { Workspaces } from "./workspaces.ts";
import {
  remoteWorkspaceGroups,
  remoteHostDisplayName,
  type RemoteWorkspaceHost,
} from "./remote-workspaces.ts";

const PREFIX = "web-remote:";
const hostsSchema = z.array(
  z.object({
    hostId: z.string().min(1),
    online: z.boolean(),
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
const rowSchema = z
  .object({
    id: z.string().min(1),
    cwd: z.string(),
    modelProvider: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    status: z.object({ type: z.string() }),
  })
  .passthrough();
const pageSchema = z.object({ data: z.array(rowSchema), nextCursor: z.string().nullable() });
const snapshotSchema = z.object({
  result: z.object({
    thread: rowSchema.extend({
      turns: z.array(
        z
          .object({
            id: z.string(),
            status: z.string(),
            items: z.array(z.object({ id: z.string(), type: z.string() }).passthrough()),
          })
          .passthrough(),
      ),
    }),
  }),
  epoch: z.string().min(1),
  interactionsAvailable: z.boolean().optional(),
  requests: z.array(
    z.object({
      id: z.union([z.string(), z.number().int()]),
      method: z.string(),
      params: z.record(z.string(), z.unknown()),
    }),
  ),
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
interface PendingRequest {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}
interface Snapshot {
  result: { thread: ChThread };
  epoch: string;
  requests: PendingRequest[];
  interactionsAvailable?: boolean;
}
interface Entry {
  identity: { hostId: string; threadId: string };
  row: ChThread;
  online: boolean;
  archived?: boolean;
  epoch?: string;
  view?: ChThreadView;
  viewOrigin?: number;
  reading?: Promise<ChThreadView>;
}
type Call = (operation: RemoteSessionOperation) => Promise<unknown>;

/** Separate remote ownership facade. Local ChSessions and native shared-backend discovery
 * retain their own lifecycle; remote cwd and attachment paths never reach local tools. */
export class RemoteSessions {
  private entries = new Map<string, Entry>();
  private hosts = new Map<string, RemoteWorkspaceHost>();
  private controls = new Set<StreamSink>();
  private pending = new Map<string, { sessionId: string; cancel(): void }>();
  private followTimers = new Set<NodeJS.Timeout>();
  private listing: Promise<void> | undefined;
  private archiveRevision = 0;
  private archiveWrites = 0;
  private discoveryUnavailable = false;
  private closed = false;
  private readonly timer: NodeJS.Timeout;
  constructor(
    private readonly events: EventHub,
    private readonly call: Call = requestRemoteSession,
    private readonly workspaces?: Workspaces,
  ) {
    this.timer = setInterval(() => {
      if (this.controls.size) void this.refresh().catch(() => undefined);
    }, 30_000);
    this.timer.unref();
  }
  private async invoke(operation: RemoteSessionOperation): Promise<unknown> {
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
    try {
      return await this.call(parsed.data);
    } catch {
      const write = !["hosts", "list", "read"].includes(operation.kind);
      throw new RpcError(
        write ? "remote/outcome-unknown" : "remote/offline",
        write
          ? "Remote operation was not confirmed; its outcome may be unknown. Refresh before deciding whether to retry."
          : "Desktop remote connection is unavailable. Reconnect in Codex Desktop and refresh. If Desktop cannot be discovered, configure CODEXHOST_DESKTOP_RUNTIME_DESCRIPTOR with its private descriptor path.",
      );
    }
  }
  refresh(): Promise<void> {
    this.listing ??= this.list().finally(() => {
      this.listing = undefined;
    });
    return this.listing;
  }
  private async list(): Promise<void> {
    if (this.archiveWrites) return;
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
    const present = new Set(hosts.filter((host) => host.online).map((host) => host.hostId));
    for (const entry of this.entries.values())
      if (!present.has(entry.identity.hostId)) this.offline(entry);
    for (const host of hosts.filter((host) => host.online)) {
      const found = new Map<string, Entry>();
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
            }),
          );
          for (const row of page.data) {
            const id = remoteSessionId(host.hostId, row.id);
            found.set(id, {
              identity: { hostId: host.hostId, threadId: row.id },
              row: { ...row, turns: [] } as ChThread,
              online: true,
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
          this.entries.set(
            id,
            previous
              ? Object.assign(previous, { row: entry.row, online: true, archived: false })
              : entry,
          );
          if (changed) this.events.emit("api-session/added", this.summary(id, entry));
        }
        this.syncArchives();
      } catch {
        host.online = false;
        for (const entry of this.entries.values())
          if (entry.identity.hostId === host.hostId) this.offline(entry);
      }
    }
    this.syncGroups();
  }
  private syncGroups(): void {
    this.workspaces?.setRemoteGroups(
      remoteWorkspaceGroups(
        this.hosts.values(),
        [...this.entries].map(([sessionId, entry]) => ({
          sessionId,
          ...entry.identity,
          cwd: entry.row.cwd,
        })),
      ),
    );
  }
  private reference(entry: Entry) {
    return { ...entry.identity };
  }
  private syncArchives(): string[] {
    const ids = [...this.entries].filter(([, entry]) => entry.archived).map(([id]) => id);
    this.workspaces?.setRemoteArchives(ids);
    return this.workspaces?.archivedSessionIds() ?? ids;
  }
  private summary(id: string, entry: Entry) {
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
          title: entry.row.name || entry.row.preview || entry.identity.threadId,
          remoteHost: {
            ...entry.identity,
            displayName: remoteHostDisplayName(
              this.hosts.get(entry.identity.hostId) ?? { hostId: entry.identity.hostId },
            ),
            state: entry.online ? "connected" : "disconnected",
          },
          ...(entry.row.modelProvider !== "codexhost"
            ? { harnessIdentity: { id: "codex", name: "Codex" } }
            : {}),
          threadReference: this.reference(entry),
          nativeConnection: { state: entry.online ? "connected" : "reconnecting" },
          nativeDiscovery: false,
          attachmentInput: { enabled: false },
          sessionListMetadata: { blank: false, lastPromptAt: entry.row.updatedAt * 1000 },
        },
      },
    };
  }
  private offline(entry: Entry): void {
    const changed = entry.online;
    entry.online = false;
    const id = remoteSessionId(entry.identity.hostId, entry.identity.threadId);
    this.clearPending(id);
    if (changed && !this.closed) this.events.emit("api-session/added", this.summary(id, entry));
    entry.view?.log.setProjection("nativeConnection", {
      state: "reconnecting",
      message: "Remote Host offline; reconnect in Desktop.",
    });
  }
  private clearPending(id: string): void {
    for (const [key, item] of this.pending)
      if (item.sessionId === id) {
        this.pending.delete(key);
        item.cancel();
      }
  }
  async read(id: string): Promise<ChThreadView> {
    const identity = remoteSessionIdentity(id);
    if (!identity) throw new RpcError("remote/identity-invalid", "Remote identity required");
    let entry = this.entries.get(id);
    if (!entry) {
      await this.refresh();
      entry = this.entries.get(id);
    }
    if (!entry) throw new RpcError("remote/not-found", "Remote Thread not found");
    const current = entry;
    current.reading ??= (async () => {
      try {
        const snapshot = snapshotSchema.parse(
          await this.invoke({ kind: "read", ...identity }),
        ) as Snapshot;
        if (this.closed || snapshot.result.thread.id !== identity.threadId)
          throw new Error("Remote identity mismatch");
        if (current.epoch && current.epoch !== snapshot.epoch) {
          this.clearPending(id);
          this.retireView(current);
        }
        current.epoch = snapshot.epoch;
        current.online = true;
        current.row = snapshot.result.thread;
        const row = { ...current.row, id, cwd: "" };
        current.view ??= this.createView(row, current.viewOrigin);
        try {
          current.view.update(row);
        } catch (error) {
          if (
            !(error instanceof RpcError) ||
            !["host/items-replaced", "host/history-changed"].includes(error.code)
          )
            throw error;
          this.retireView(current);
          current.view = this.createView(row, current.viewOrigin);
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
            ].includes(key)
          )
            current.view.log.setProjection(key, value);
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
        return current.view;
      } catch (error) {
        this.offline(current);
        throw error;
      }
    })().finally(() => {
      delete current.reading;
    });
    return current.reading;
  }
  private retireView(entry: Entry): void {
    if (!entry.view) return;
    entry.viewOrigin = entry.view.log.lastSeq + 1;
    entry.view.retire();
    entry.view.log.reconnectFollowers();
    delete entry.view;
  }
  private createView(row: ChThread, origin = 0): ChThreadView {
    const view = new ChThreadView(
      row,
      row.modelProvider === "codexhost" ? "remote" : "codex",
      (sessionId, key, value, seq) => {
        view.log.pushProjection(key, value, seq);
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
      if (method === "session/list") {
        const request = requestOf<{ sessionId?: unknown; cursor?: unknown }>(args);
        if (request.sessionId !== undefined) {
          const id = request.sessionId;
          if (typeof id !== "string" || !id.startsWith(PREFIX)) return next();
          remoteSessionIdentity(id);
          if (request.cursor !== undefined)
            throw new RpcError("session/list-invalid", "Invalid direct-link identity.");
          if (!this.entries.has(id)) await this.refresh();
          const entry = this.entries.get(id);
          if (!entry) throw new RpcError("remote/not-found", "Remote Thread not found");
          return { items: [this.summary(id, entry)], archivedSessionIds: this.syncArchives() };
        }
        void this.refresh().catch(() => undefined);
        const local = await next();
        return {
          ...(local as object),
          items: [
            ...(local as { items: unknown[] }).items,
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
      const view = await this.read(id);
      if (sink.closed) return true;
      view.log.follow(toolOutputSink(view.log, sink), requestOf(args));
      let busy = false,
        failures = 0,
        retryAt = 0;
      const timer = setInterval(() => {
        if (busy || sink.closed || this.closed || Date.now() < retryAt) return;
        busy = true;
        void this.read(id)
          .then(() => {
            failures = 0;
            retryAt = 0;
          })
          .catch(() => {
            // The offline projection is already published by read(). Keep the
            // subscription alive and back off until this viewer closes.
            failures = Math.min(failures + 1, 5);
            retryAt = Date.now() + Math.min(30_000, 1500 * 2 ** failures);
          })
          .finally(() => {
            busy = false;
          });
      }, 1500);
      timer.unref();
      this.followTimers.add(timer);
      sink.onClose(() => {
        clearInterval(timer);
        this.followTimers.delete(timer);
      });
      return true;
    });
  }
  private async handle(
    method: string,
    id: string,
    request: Record<string, unknown>,
  ): Promise<unknown> {
    const readOnly = ["session/projections", "session/page", "session/toolOutput"].includes(method);
    const cached = readOnly ? this.entries.get(id)?.view : undefined;
    const view = cached ?? (await this.read(id));
    if (method === "session/projections") return view.log.projectionBaseline();
    if (method === "session/page")
      return view.log.page(
        Number(request.throughSeq),
        typeof request.beforeSeq === "number" ? request.beforeSeq : undefined,
        { maxMessages: typeof request.maxMessages === "number" ? request.maxMessages : 20 },
      );
    if (method === "session/toolOutput")
      return readToolOutput(view.log, webToolOutputReferenceSchema.parse(request));
    const entry = this.entries.get(id);
    if (!entry?.epoch) throw new RpcError("remote/offline", "Remote connection changed");
    const base = { ...entry.identity, epoch: entry.epoch };
    let operation: RemoteSessionOperation;
    switch (method) {
      case "session/prompt": {
        const content = request.content as Array<{ type: string; text?: string }>;
        if (
          !Array.isArray(content) ||
          content.some((part) => part.type !== "text") ||
          request.mode === "steer"
        )
          throw new RpcError(
            "remote/unsupported",
            "Remote follow-up accepts text only; steering and uploads are unavailable",
          );
        if (entry.row.status.type === "active")
          throw new RpcError("remote/busy", "Wait for the remote turn or stop it before sending");
        operation = {
          kind: "prompt",
          ...base,
          text: content.map((part) => part.text ?? "").join("\n"),
          ...(typeof request.requestId === "string" ? { requestId: request.requestId } : {}),
        };
        break;
      }
      case "session/cancel": {
        const turn = entry.row.turns.find((turn) => turn.status === "inProgress");
        if (!turn) throw new RpcError("remote/stop-unavailable", "No interruptible remote turn");
        operation = { kind: "interrupt", ...base, turnId: turn.id };
        break;
      }
      case "session/rename":
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
    try {
      await this.invoke(operation);
    } finally {
      if (operation.kind === "archive") {
        this.archiveWrites--;
        this.archiveRevision++;
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
    for (const timer of this.followTimers) clearInterval(timer);
    this.followTimers.clear();
    for (const id of this.entries.keys()) this.clearPending(id);
    for (const entry of this.entries.values()) entry.view?.log.reconnectFollowers();
    this.controls.clear();
  }
}
