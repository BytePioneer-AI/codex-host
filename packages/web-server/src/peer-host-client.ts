import * as c from "@codexhost/shared-contracts";
import type { HostClientUpdate } from "@codexhost/desktop-control";
import { setTimeout as sleep } from "node:timers/promises";
import type { PeerChTransport } from "./peer-ch-host-client.ts";
import { classifyPeerTransport, type PeerRecord } from "./peer-host-store.ts";
import { RpcError } from "./transport.ts";

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 45_000;

export type PeerFetchPath = `/api/${"ch" | "peer"}/v1/${string}`;

export interface PeerFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | object;
  signal?: AbortSignal;
  timeoutMs?: number;
  duplex?: "half";
  /** Bound only the initial response handshake by timeoutMs (used for streaming endpoints). */
  stream?: boolean;
}

function isRawBodyInit(body: BodyInit | object): body is BodyInit {
  return (
    typeof body === "string" ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof ReadableStream
  );
}

export async function peerFetch(
  record: PeerRecord,
  path: PeerFetchPath,
  init: PeerFetchInit = {},
): Promise<Response> {
  if (!record.enabled) throw new RpcError("remote/offline", "Remote peer is disabled");
  const requestTimeoutMs = init.timeoutMs ?? (path.startsWith("/api/ch/v1/") ? 60_000 : 8_000);
  const handshake = new AbortController();
  const timer = init.stream ? setTimeout(() => handshake.abort(), init.timeoutMs ?? 8_000) : null;
  const headers = new Headers(init.headers);
  let requestBody: BodyInit | undefined;
  if (init.body !== undefined) {
    if (isRawBodyInit(init.body)) {
      requestBody = init.body;
    } else {
      requestBody = JSON.stringify(init.body);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }
  } else if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  headers.set("authorization", "Bearer " + record.token);
  const signals: AbortSignal[] = [];
  if (init.stream) {
    signals.push(handshake.signal);
    if (init.signal) signals.push(init.signal);
  } else {
    signals.push(AbortSignal.timeout(requestTimeoutMs));
    if (init.signal) signals.push(init.signal);
  }
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  try {
    const requestInit: RequestInit & { duplex?: "half" } = {
      method: init.method ?? "GET",
      redirect: "error",
      headers,
      ...(requestBody === undefined ? {} : { body: requestBody }),
      ...(init.duplex === undefined ? {} : { duplex: init.duplex }),
      ...(signal === undefined ? {} : { signal }),
    };
    const res = await fetch(record.origin + path, requestInit);
    if (res.ok) return res;
    const failure = await res
      .json()
      .then((payload: unknown) => {
        if (!payload || typeof payload !== "object" || !("error" in payload)) return undefined;
        const err = payload.error;
        if (typeof err === "string") return { message: err };
        if (err && typeof err === "object" && "message" in err && typeof err.message === "string")
          return {
            message: err.message,
            code: "code" in err && typeof err.code === "number" ? err.code : undefined,
          };
        return undefined;
      })
      .catch(() => undefined);
    if (res.status === 401 || (res.status === 403 && !failure?.message))
      throw new RpcError("remote/auth-error", "Remote peer rejected the access token", {
        httpStatus: res.status,
      });
    throw new RpcError(
      "remote/request-failed",
      failure?.message ?? `Remote peer returned HTTP ${res.status}`,
      {
        httpStatus: res.status,
        ...(failure?.code === undefined ? {} : { hostCode: failure.code }),
      },
    );
  } catch (err) {
    if (err instanceof RpcError) throw err;
    throw new RpcError("remote/offline", "Remote peer is unreachable");
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export class PeerHostClient {
  private life = new AbortController();
  manifest?: c.RemotePeerManifest;
  latencyMs?: number;
  lastError?: string;
  state: c.RemotePeerState;
  private cursor?: c.ClientChannelCursor;
  private streamOnline = false;
  private readonly listeners = new Set<(update: HostClientUpdate) => void>();
  private readonly streamIdleTimeoutMs: number;
  readonly hostId: string;

  constructor(
    readonly record: PeerRecord,
    private changed: (hostId?: string) => void,
    options: { streamIdleTimeoutMs?: number; initialManifest?: c.RemotePeerManifest } = {},
  ) {
    this.hostId = c.remotePeerHostId(record.peerId);
    this.state = record.enabled ? "connecting" : "disabled";
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    if (options.initialManifest !== undefined) {
      this.manifest = options.initialManifest;
    }
  }

  summary(): c.RemotePeerSummary {
    const { peerId, name, origin, enabled, createdAt, updatedAt } = this.record;
    const { encrypted, transportKind } = classifyPeerTransport(origin);
    const { version, platform, hostname, homeDir, projects } = this.manifest ?? {};
    return {
      peerId,
      name,
      origin,
      enabled,
      createdAt,
      updatedAt,
      hostId: this.hostId,
      state: this.state,
      encrypted,
      transportKind,
      version,
      platform,
      hostname,
      homeDir,
      latencyMs: this.latencyMs,
      lastError: this.lastError,
      projectCount: projects?.length ?? 0,
    };
  }

  private publish(update: HostClientUpdate): void {
    for (const listener of [...this.listeners]) {
      if (this.listeners.has(listener)) listener(update);
    }
  }

  private setStreamOffline(): void {
    if (!this.streamOnline) return;
    this.streamOnline = false;
    this.publish({ type: "connection", online: false });
  }

  subscribe(listener: (update: HostClientUpdate) => void): () => void {
    this.listeners.add(listener);
    listener({ type: "connection", online: this.streamOnline });
    if (this.streamOnline && this.cursor && this.listeners.has(listener)) {
      listener({ type: "hello", version: 1, cursor: this.cursor, reset: false });
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  async post<T>(route: "rpc" | "snapshot" | "respond", body: object): Promise<T> {
    if (this.state !== "connected") {
      throw new RpcError("remote/offline", "Remote peer is not connected");
    }
    const res = await this.fetch(`/api/ch/v1/${route}`, "POST", body);
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new RpcError("remote/read-failed", "Remote peer returned invalid JSON");
    }
    if (!payload || typeof payload !== "object" || !("result" in payload)) {
      throw new RpcError("remote/read-failed", "Remote peer response missing result");
    }
    return (payload as { result: T }).result;
  }

  chTransport(): PeerChTransport {
    return {
      post: <T>(route: "rpc" | "snapshot" | "respond", body: object) => this.post<T>(route, body),
      subscribe: (listener: (update: HostClientUpdate) => void) => this.subscribe(listener),
      manifest: () => this.manifest,
    };
  }

  private fetch(path: PeerFetchPath, method = "GET", body?: unknown, streamSignal?: AbortSignal) {
    return peerFetch(this.record, path, {
      method,
      ...(body === undefined ? {} : { body: body as BodyInit | object }),
      ...(streamSignal
        ? { stream: true, signal: AbortSignal.any([streamSignal, this.life.signal]) }
        : { signal: this.life.signal }),
    });
  }

  async probe() {
    const start = Date.now();
    try {
      this.manifest = c.remotePeerManifestSchema.parse(
        await (await this.fetch("/api/peer/v1/manifest")).json(),
      );
      this.latencyMs = Date.now() - start;
      delete this.lastError;
      this.state = "connected";
    } catch (e) {
      this.state =
        e instanceof RpcError && e.code === "remote/auth-error" ? "auth-error" : "offline";
      const message =
        this.state === "auth-error"
          ? "Remote peer rejected the access token"
          : "Remote peer manifest unavailable";
      this.lastError = message;
      this.setStreamOffline();
      throw Error(message);
    }
  }

  async start() {
    if (!this.record.enabled) return;
    let delay = 1000;
    while (!this.life.signal.aborted) {
      const streamAbort = new AbortController();
      let idleTimer: NodeJS.Timeout | undefined;
      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          streamAbort.abort(new Error("Remote peer stream idle timeout"));
        }, this.streamIdleTimeoutMs);
        idleTimer.unref();
      };
      try {
        if (this.state !== "connected") await this.probe();
        if (this.life.signal.aborted) return;
        this.changed(this.hostId);
        const query = this.cursor
          ? "?" +
            new URLSearchParams({ epoch: this.cursor.epoch, after: String(this.cursor.sequence) })
          : "";
        const response = await this.fetch(
          `/api/ch/v1/events${query}`,
          "GET",
          undefined,
          streamAbort.signal,
        );
        if (!response.body) throw new RpcError("remote/offline", "Remote peer stream unavailable");
        let checked = Date.now();
        let pending = "";
        const decoder = new TextDecoder();
        resetIdleTimer();
        for await (const chunk of response.body) {
          resetIdleTimer();
          if (Date.now() - checked >= 30000) {
            const before = JSON.stringify(this.manifest);
            await this.probe();
            checked = Date.now();
            if (before !== JSON.stringify(this.manifest)) this.changed(this.hostId);
          }
          pending += decoder.decode(chunk, { stream: true });
          let i;
          while ((i = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, i);
            pending = pending.slice(i + 1);
            if (!line.trim()) continue;
            let raw: unknown;
            try {
              raw = JSON.parse(line);
            } catch {
              continue;
            }
            const parsed = c.clientChannelEventSchema.safeParse(raw);
            if (!parsed.success) continue;
            const event = parsed.data;
            this.cursor = event.cursor;
            if (event.type === "hello") {
              if (this.manifest?.epoch !== event.cursor.epoch) {
                await this.probe();
                this.changed(this.hostId);
              }
              delay = 1000;
              if (!this.streamOnline) {
                this.streamOnline = true;
                this.publish({ type: "connection", online: true });
              }
              this.publish(event);
            } else {
              delay = 1000;
              this.publish(event);
            }
          }
          if (pending.length > 4194304) throw Error("Invalid stream");
        }
      } catch (e) {
        if (e instanceof RpcError && e.code === "remote/auth-error") this.state = "auth-error";
        this.lastError = e instanceof Error ? e.message : "Remote peer stream disconnected";
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        streamAbort.abort();
        this.setStreamOffline();
      }
      if (this.life.signal.aborted) return;
      if (this.state !== "auth-error") this.state = "offline";
      this.changed(this.hostId);
      await sleep(delay, undefined, { signal: this.life.signal }).catch(() => {});
      delay = Math.min(delay * 2, 30000);
    }
  }

  close() {
    this.life.abort();
    this.setStreamOffline();
    this.listeners.clear();
  }

  async listDirs(path?: string) {
    return c.remotePeerListDirsResultSchema.parse(
      await (
        await this.fetch(
          path ? `/api/peer/v1/dirs?${new URLSearchParams({ path })}` : "/api/peer/v1/dirs",
        )
      ).json(),
    );
  }

  async createDir(parentPath: string, name: string) {
    return c.remotePeerCreateDirResultSchema.parse(
      await (await this.fetch("/api/peer/v1/dirs", "POST", { parentPath, name })).json(),
    );
  }

  createWorkspace({ path, title }: Pick<c.RemotePeerCreateWorkspaceParams, "path" | "title">) {
    return this.workspace("POST", { path, title });
  }

  renameWorkspace({
    workspaceId,
    title,
  }: Pick<c.RemotePeerRenameWorkspaceParams, "workspaceId" | "title">) {
    return this.workspace("PATCH", { workspaceId, title });
  }

  deleteWorkspace(workspaceId: string) {
    return this.workspace("DELETE", { workspaceId });
  }

  private async workspace(method: string, params: object) {
    const result = c.remotePeerWorkspaceMutationResultSchema.parse(
      await (await this.fetch("/api/peer/v1/workspaces", method, params)).json(),
    );
    this.manifest = result.manifest;
    this.changed(this.hostId);
    return result;
  }

  async call(op: c.RemoteSessionOperation): Promise<unknown> {
    const epoch = this.manifest?.epoch;
    if (this.state !== "connected")
      throw new RpcError("remote/offline", "Remote peer is not connected");
    if ("epoch" in op && op.epoch !== epoch)
      throw new RpcError("remote/connection-changed", "Remote peer restarted");
    const post = <T = unknown>(route: "rpc" | "snapshot" | "respond", input: object) =>
      this.post<T>(route, input);
    const rpc = (method: string, params: object) =>
      post<Record<string, unknown>>("rpc", { method, params });
    const threadId = "threadId" in op ? op.threadId : "";
    const base = { threadId };
    switch (op.kind) {
      case "status": {
        const s = c.clientThreadSnapshotSchema.parse(await post("snapshot", base));
        if (s.thread.id !== threadId || s.cursor.epoch !== epoch)
          throw new RpcError("remote/connection-changed", "Remote peer snapshot changed");
        return {
          threadId,
          status: s.thread.status.type,
          turnId: s.activeTurnId ?? null,
          epoch,
          supportsDelivery: true,
          ...(s.thread.canAcceptDirectInput === false ? { readOnly: true } : {}),
        };
      }
      case "usage":
        return rpc("codexhost/thread/usage/inspect", base);
      case "create":
        return rpc("thread/start", { cwd: op.cwd, historyMode: "paginated" });
      case "startSelected": {
        const result = (await rpc("thread/start", {
          cwd: op.cwd,
          historyMode: "paginated",
          model: op.model,
          ...(op.serviceTier ? { serviceTier: op.serviceTier } : {}),
          ...(op.reasoningEffort ? { config: { model_reasoning_effort: op.reasoningEffort } } : {}),
        })) as { thread: { id: string } };
        const owner = (await rpc("codexhost/thread/inspect", { threadId: result.thread.id })) as {
          owner?: string;
          harnessId?: string;
        };
        if ((owner.owner === "codex" ? "codex" : owner.harnessId) !== op.harnessId) {
          await rpc("thread/archive", { threadId: result.thread.id }).catch(() => undefined);
          throw Error("Selected Harness not confirmed");
        }
        return result;
      }
      case "configure":
        return op.modelId
          ? rpc("codexhost/thread/model/select", {
              threadId,
              model: { id: op.modelId, serviceTier: op.serviceTier },
            })
          : op.thinkingOptionId
            ? rpc("codexhost/thread/thinking/select", {
                threadId,
                thinkingOptionId: op.thinkingOptionId,
              })
            : rpc("codexhost/thread/permission-mode/select", {
                threadId,
                permissionModeId: op.permissionModeId,
              });
      case "prompt": {
        const clientUserMessageId = op.requestId?.trim();
        return rpc("turn/start", {
          threadId,
          input: [{ type: "text", text: op.text, text_elements: [] }],
          ...(clientUserMessageId ? { clientUserMessageId } : {}),
        });
      }
      case "delivery": {
        const a = op.action;
        const snapshot = c.clientThreadSnapshotSchema.parse(await post("snapshot", base));
        const thread = snapshot.thread;
        const external = thread.modelProvider === "codexhost" && thread.cliVersion === "codexhost";
        if (thread.canAcceptDirectInput === false)
          return { accepted: false, code: "remote/send-rejected", message: "Thread is read-only" };
        if (a.kind === "steer" && external && !thread.codexhostSupportsStrictSteer)
          return {
            accepted: false,
            code: "remote/steer-unavailable",
            message: "Remote peer cannot confirm the target turn",
          };
        if (a.kind === "start" && a.onlyIfHead) {
          const page = (await rpc("thread/queue/list", { threadId, limit: 1 })) as {
            data: Array<{ id?: string }>;
          };
          if (page.data[0]?.id !== a.itemId) return { accepted: true };
        }
        if (a.kind === "start" || a.kind === "remove") {
          const result = (await rpc("thread/queue/" + (a.kind === "start" ? "start" : "delete"), {
            threadId,
            queuedSubmissionId: a.itemId,
          })) as { deleted?: boolean; turn?: { id?: string } };
          if (a.kind === "remove" && !result.deleted)
            return {
              accepted: false,
              code: "session/queue-item-not-found",
              message: "Queued message no longer pending",
            };
          if (a.kind === "start" && !result.turn?.id) throw Error("Queued turn not confirmed");
        } else {
          const result = (await rpc(a.kind === "steer" ? "turn/steer" : "thread/queue/add", {
            threadId,
            input: [{ type: "text", text: a.text, text_elements: [] }],
            clientUserMessageId: a.requestId,
            ...(a.kind === "steer"
              ? {
                  expectedTurnId: a.turnId,
                  ...(external ? { codexhostSteerStrictTarget: true } : {}),
                }
              : external && thread.status.type === "idle"
                ? { codexhostQueueStartIfEmpty: true }
                : {}),
          })) as {
            queuedSubmission?: { id?: string; clientUserMessageId?: string };
            turnId?: string;
            delivery?: string;
          };
          if (a.kind === "enqueue") {
            const item = result.queuedSubmission;
            if (!item?.id || item.clientUserMessageId !== a.requestId)
              throw Error("Queue admission not confirmed");
            if (!external && thread.status.type === "idle" && snapshot.queue?.items.length === 0)
              return { accepted: true, startQueuedItemId: item.id };
          } else if (
            result.turnId !== a.turnId &&
            !(external && result.delivery === "newTurn" && result.turnId)
          )
            throw Error("Steering not confirmed");
        }
        return { accepted: true };
      }
      case "interrupt":
        return rpc("turn/interrupt", { threadId, turnId: op.turnId });
      case "rename":
        return rpc("thread/name/set", { threadId, name: op.name });
      case "archive":
        return rpc(op.archived ? "thread/archive" : "thread/unarchive", base);
      case "respond":
        return post("respond", {
          threadId,
          epoch: op.epoch,
          requestId: op.requestId,
          result: op.result,
        });
      default:
        throw Error("Invalid peer operation");
    }
  }
}
