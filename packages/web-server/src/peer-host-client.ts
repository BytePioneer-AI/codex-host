import * as c from "@codexhost/shared-contracts";
import { setTimeout as sleep } from "node:timers/promises";
import { parseConnectionLink, type PeerRecord } from "./peer-host-store.ts";
import { RpcError } from "./transport.ts";
export class PeerHostClient {
  private life = new AbortController();
  manifest?: c.RemotePeerManifest;
  latencyMs?: number;
  lastError?: string;
  state: c.RemotePeerState;
  private timer?: NodeJS.Timeout;
  private cursor?: c.ClientChannelCursor;
  constructor(
    readonly record: PeerRecord,
    private changed: () => void,
  ) {
    this.state = record.enabled ? "connecting" : "disabled";
  }
  summary(): c.RemotePeerSummary {
    const { peerId, name, origin, enabled, createdAt, updatedAt } = this.record;
    const { encrypted, transportKind } = parseConnectionLink(this.record);
    const { version, platform, hostname, homeDir, projects } = this.manifest ?? {};
    return {
      peerId,
      name,
      origin,
      enabled,
      createdAt,
      updatedAt,
      hostId: c.remotePeerHostId(peerId),
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
  private async fetch(path: string, method = "GET", body?: unknown, stream = false) {
    if (!this.record.enabled) throw new RpcError("remote/offline", "Remote peer is disabled");
    const handshake = new AbortController();
    const timer = setTimeout(() => handshake.abort(), 8000);
    try {
      const res = await fetch(this.record.origin + path, {
        method,
        redirect: "error",
        headers: {
          authorization: "Bearer " + this.record.token,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: stream
          ? AbortSignal.any([handshake.signal, this.life.signal])
          : AbortSignal.any([this.life.signal, AbortSignal.timeout(8000)]),
      });
      if (res.ok) return res;
      const failure = await res
        .json()
        .then((body: unknown) =>
          body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error
            : undefined,
        )
        .catch(() => undefined);
      if ([401, 403].includes(res.status))
        throw new RpcError("remote/auth-error", "Remote peer rejected the access token");
      throw new RpcError(
        "remote/request-failed",
        failure ?? `Remote peer returned HTTP ${res.status}`,
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
  async start() {
    if (!this.record.enabled) return;
    let delay = 1000;
    while (!this.life.signal.aborted) {
      try {
        if (this.state !== "connected") await this.probe();
        if (this.life.signal.aborted) return;
        this.changed();
        const query = this.cursor
          ? "?" +
            new URLSearchParams({ epoch: this.cursor.epoch, after: String(this.cursor.sequence) })
          : "";
        const response = await this.fetch("/api/ch/v1/events" + query, "GET", undefined, true);
        if (!response.body) throw new RpcError("remote/offline", "Remote peer stream unavailable");
        let checked = Date.now();
        let pending = "";
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          if (Date.now() - checked >= 30000) {
            const before = JSON.stringify(this.manifest);
            await this.probe();
            checked = Date.now();
            if (before !== JSON.stringify(this.manifest)) this.changed();
          }
          pending += decoder.decode(chunk, { stream: true });
          let i;
          while ((i = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, i);
            pending = pending.slice(i + 1);
            if (!line.trim()) continue;
            const event = JSON.parse(line);
            this.cursor = c.clientChannelCursorSchema.parse(event.cursor);
            if (event.type === "hello" && this.manifest?.epoch !== this.cursor.epoch)
              await this.probe();
            delay = 1000;
            if (!this.timer)
              this.timer = setTimeout(() => {
                delete this.timer;
                this.changed();
              }, 100);
          }
          if (pending.length > 4194304) throw Error("Invalid stream");
        }
      } catch (e) {
        if (e instanceof RpcError && e.code === "remote/auth-error") this.state = "auth-error";
        this.lastError = e instanceof Error ? e.message : "Remote peer stream disconnected";
      }
      if (this.life.signal.aborted) return;
      if (this.state !== "auth-error") this.state = "offline";
      this.changed();
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
    this.changed();
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
        const loaded = op.includeLoaded ? await loadedThreadIds() : null;
        return {
          ...(await rpc("thread/list", { cursor: op.cursor, archived: op.archived, limit: 100 })),
          ...(loaded ? { loaded, epoch } : {}),
        };
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
      case "create":
        return rpc("thread/start", { cwd: op.cwd, historyMode: "paginated" });
      case "startSelected": {
        const result = await rpc("thread/start", {
          cwd: op.cwd,
          historyMode: "paginated",
          model: op.model,
          serviceTier: op.serviceTier,
          config: { model_reasoning_effort: op.reasoningEffort },
        });
        const owner = await rpc("codexhost/thread/inspect", { threadId: result.thread.id });
        if ((owner.owner === "codex" ? "codex" : owner.harnessId) !== op.harnessId)
          throw Error("Selected Harness not confirmed");
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
      case "prompt":
        {
          const loaded = await loadedThreadIds();
          if (!loaded.includes(threadId))
            await rpc("thread/resume", { threadId, excludeTurns: true });
        }
        return rpc("turn/start", {
          threadId,
          input: [{ type: "text", text: op.text, text_elements: [] }],
          clientUserMessageId: op.requestId,
        });
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
