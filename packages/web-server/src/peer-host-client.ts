import * as c from "@codexhost/shared-contracts";
import { setTimeout as sleep } from "node:timers/promises";
import { classifyPeerTransport, type PeerRecord } from "./peer-host-store.ts";
import { RpcError } from "./transport.ts";

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 45_000;

export function isCatalogChangingEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const record = event as { type?: unknown; method?: unknown };
  if (record.type === "hello") return true;
  if (record.type !== "changed" || typeof record.method !== "string") return false;
  const method = record.method;
  return (
    (method.startsWith("thread/") && method !== "thread/tokenUsage/updated") ||
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "codexhost/thread/pins/changed" ||
    method === "codexhost/thread/tree/changed"
  );
}

export class PeerHostClient {
  private life = new AbortController();
  manifest?: c.RemotePeerManifest;
  latencyMs?: number;
  lastError?: string;
  state: c.RemotePeerState;
  private timer?: NodeJS.Timeout;
  private cursor?: c.ClientChannelCursor;
  private createdEpoch: string | undefined;
  private createdThreads = new Set<string>();
  private readonly streamIdleTimeoutMs: number;
  readonly hostId: string;

  constructor(
    readonly record: PeerRecord,
    private changed: (hostId?: string) => void,
    options: { streamIdleTimeoutMs?: number } = {},
  ) {
    this.hostId = c.remotePeerHostId(record.peerId);
    this.state = record.enabled ? "connecting" : "disabled";
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
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

  private noteCreatedThread(threadId: string, epoch: string) {
    if (this.createdEpoch !== epoch) {
      this.createdEpoch = epoch;
      this.createdThreads.clear();
    }
    this.createdThreads.add(threadId);
  }

  private async fetch(path: string, method = "GET", body?: unknown, streamSignal?: AbortSignal) {
    if (!this.record.enabled) throw new RpcError("remote/offline", "Remote peer is disabled");
    const requestTimeoutMs = path.startsWith("/api/ch/v1/") ? 60_000 : 8_000;
    const handshake = new AbortController();
    const timer = setTimeout(() => handshake.abort(), 8_000);
    try {
      const res = await fetch(this.record.origin + path, {
        method,
        redirect: "error",
        headers: {
          authorization: "Bearer " + this.record.token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: streamSignal
          ? AbortSignal.any([handshake.signal, streamSignal, this.life.signal])
          : AbortSignal.any([this.life.signal, AbortSignal.timeout(requestTimeoutMs)]),
      });
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
        throw new RpcError("remote/auth-error", "Remote peer rejected the access token");
      throw new RpcError(
        "remote/request-failed",
        failure?.message ?? `Remote peer returned HTTP ${res.status}`,
        failure?.code === undefined ? {} : { hostCode: failure.code },
      );
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw new RpcError("remote/offline", "Remote peer is unreachable");
    } finally {
      clearTimeout(timer);
    }
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
      throw Error(message);
    }
  }

  private scheduleChanged() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      delete this.timer;
      this.changed(this.hostId);
    }, 100);
    this.timer.unref();
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
          "/api/ch/v1/events" + query,
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
            const event: unknown = JSON.parse(line);
            this.cursor = c.clientChannelCursorSchema.parse((event as { cursor?: unknown }).cursor);
            if (
              (event as { type?: unknown }).type === "hello" &&
              this.manifest?.epoch !== this.cursor.epoch
            ) {
              await this.probe();
            }
            delay = 1000;
            if (isCatalogChangingEvent(event)) {
              this.scheduleChanged();
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
    clearTimeout(this.timer);
  }

  async listDirs(path?: string) {
    return c.remotePeerListDirsResultSchema.parse(
      await (
        await this.fetch("/api/peer/v1/dirs" + (path ? "?" + new URLSearchParams({ path }) : ""))
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
    if (
      ("epoch" in op && op.epoch !== epoch) ||
      (op.kind === "read" && op.page?.epoch && op.page.epoch !== epoch)
    )
      throw new RpcError("remote/connection-changed", "Remote peer restarted");
    const post = async (route: string, input: object) =>
      (await (await this.fetch("/api/ch/v1/" + route, "POST", input)).json()).result;
    const rpc = (method: string, params: object) => post("rpc", { method, params });
    const loadedThreadIds = async (): Promise<string[]> => {
      const raw = await rpc(c.LOADED_SESSIONS_METHOD, {}).catch(() => []);
      if (Array.isArray(raw))
        return raw
          .map((item) =>
            item && typeof item === "object"
              ? (item as { threadId?: unknown }).threadId
              : undefined,
          )
          .filter((id): id is string => typeof id === "string" && id.length > 0);
      if (raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data))
        return (raw as { data: unknown[] }).data.filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        );
      return [];
    };
    const threadId = "threadId" in op ? op.threadId : "";
    const base = { threadId };
    switch (op.kind) {
      case "list": {
        const page = await rpc("thread/list", {
          cursor: op.cursor,
          archived: op.archived,
          limit: 100,
        });
        if (this.createdEpoch !== epoch) {
          this.createdEpoch = epoch;
          this.createdThreads.clear();
        }
        if (Array.isArray(page?.data)) {
          for (const row of page.data) {
            if (row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string")
              this.createdThreads.delete((row as { id: string }).id);
          }
        }
        if (!op.includeLoaded) return page;
        const loaded = [...new Set([...(await loadedThreadIds()), ...this.createdThreads])];
        return { ...page, loaded, epoch };
      }
      case "read":
      case "status":
      case "queue": {
        const s = c.clientThreadSnapshotSchema.parse(await post("snapshot", base));
        if (s.thread.id !== threadId || s.cursor.epoch !== epoch)
          throw new RpcError("remote/connection-changed", "Remote peer snapshot changed");
        if (op.kind === "status")
          return {
            threadId,
            status: s.thread.status.type,
            turnId: s.activeTurnId ?? null,
            epoch,
            supportsDelivery: true,
            readOnly: s.thread.canAcceptDirectInput === false,
          };
        if (op.kind === "queue")
          return s.queue
            ? {
                available: true,
                items: s.queue.items.map((i) => ({
                  id: i.id,
                  clientUserMessageId: i.clientUserMessageId,
                  preview: i.input
                    .map((p) => p.text ?? "")
                    .join("")
                    .slice(0, 800),
                })),
              }
            : { available: false };
        let page =
          !op.page && !s.turnsPage.nextCursor
            ? { data: [...s.turnsPage.data].reverse(), nextCursor: null }
            : await rpc("thread/turns/list", {
                threadId,
                cursor: op.page?.cursor ?? null,
                limit: op.page?.limit ?? 20,
                sortDirection: op.page?.sortDirection ?? "asc",
                itemsView: "full",
              });
        const turns = [...page.data];
        const seen = new Set<string>();
        while (!op.page && page.nextCursor) {
          if (seen.has(page.nextCursor) || seen.size >= 100)
            throw new RpcError(
              "remote/history-too-large",
              "Remote history exceeds bounded traversal",
            );
          seen.add(page.nextCursor);
          page = await rpc("thread/turns/list", {
            threadId,
            cursor: page.nextCursor,
            limit: 20,
            sortDirection: "asc",
            itemsView: "full",
          });
          turns.push(...page.data);
        }
        const configuration = await rpc("codexhost/thread/inspect", base).catch(() => undefined);
        const harnessId = configuration?.owner === "codex" ? "codex" : configuration?.harnessId;
        const [inspection, catalog] = harnessId
          ? await Promise.all([
              rpc("codexhost/harness/inspect", { harnessId, cwd: s.thread.cwd }).catch(
                () => undefined,
              ),
              rpc("codexhost/harness/plugins/list", {}).catch(() => undefined),
            ])
          : [];
        return {
          epoch,
          result: { thread: { ...s.thread, turns } },
          requests: s.interactions.map((i) => ({ ...i.request, id: i.requestId })),
          nextCursor: page.nextCursor,
          configuration,
          inspection,
          harness: catalog?.plugins?.find((p: { id: string }) => p.id === harnessId),
          nativeSettings: s.configuration.native,
        };
      }
      case "usage":
        return rpc("codexhost/thread/usage/inspect", base);
      case "projectHarnesses":
        return (await rpc("codexhost/harness/plugins/list", {})).plugins.filter(
          (p: { kind?: string }) => p.kind !== "usage",
        );
      case "inspectHarness":
        return rpc("codexhost/harness/inspect", { cwd: op.cwd, harnessId: op.harnessId });
      case "create": {
        const result = await rpc("thread/start", { cwd: op.cwd, historyMode: "paginated" });
        if (epoch && typeof result?.thread?.id === "string") {
          this.noteCreatedThread(result.thread.id, epoch);
        }
        return result;
      }
      case "startSelected": {
        const result = await rpc("thread/start", {
          cwd: op.cwd,
          historyMode: "paginated",
          model: op.model,
          ...(op.serviceTier ? { serviceTier: op.serviceTier } : {}),
          ...(op.reasoningEffort ? { config: { model_reasoning_effort: op.reasoningEffort } } : {}),
        });
        const owner = await rpc("codexhost/thread/inspect", { threadId: result.thread.id });
        if ((owner.owner === "codex" ? "codex" : owner.harnessId) !== op.harnessId) {
          await rpc("thread/archive", { threadId: result.thread.id }).catch(() => undefined);
          throw Error("Selected Harness not confirmed");
        }
        if (epoch && typeof result?.thread?.id === "string") {
          this.noteCreatedThread(result.thread.id, epoch);
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
          const page = await rpc("thread/queue/list", { threadId, limit: 1 });
          if (page.data[0]?.id !== a.itemId) return { accepted: true };
        }
        if (a.kind === "start" || a.kind === "remove") {
          const result = await rpc("thread/queue/" + (a.kind === "start" ? "start" : "delete"), {
            threadId,
            queuedSubmissionId: a.itemId,
          });
          if (a.kind === "remove" && !result.deleted)
            return {
              accepted: false,
              code: "session/queue-item-not-found",
              message: "Queued message no longer pending",
            };
          if (a.kind === "start" && !result.turn?.id) throw Error("Queued turn not confirmed");
        } else {
          const result = await rpc(a.kind === "steer" ? "turn/steer" : "thread/queue/add", {
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
          });
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
      case "archive": {
        const res = await rpc(op.archived ? "thread/archive" : "thread/unarchive", base);
        if (op.archived) this.createdThreads.delete(threadId);
        return res;
      }
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
