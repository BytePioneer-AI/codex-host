import type { RemoteSessionOperation } from "@codexhost/shared-contracts";

interface Request {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}
interface Manager {
  sendRequest(method: string, params: unknown): unknown;
  getConversation?(id: string): unknown;
  replyWithCommandExecutionApprovalDecision?(
    threadId: string,
    requestId: string | number,
    decision: string,
  ): unknown;
  replyWithFileChangeApprovalDecision?(
    threadId: string,
    requestId: string | number,
    decision: string,
  ): unknown;
}
export interface RemoteSessionTarget {
  __codexhostRendererBindingProbeV1?: { remoteConnections(input: unknown): Promise<unknown> };
  __codexhostHostRoutingV1?: {
    knownHostIds?(): readonly string[];
    forHost(id: string): { manager: Manager } | null;
  };
  __codexhostRemoteSessionsV1?: {
    managers: WeakMap<
      object,
      {
        epoch: string;
        answered: Set<string>;
        metadata?: Map<
          string,
          { loading: Promise<Record<string, unknown>>; failures: number; retryAt: number }
        >;
      }
    >;
    reconnectAttempts?:
      Set<string> | Map<string, { failures: number; retryAt: number; loading?: Promise<void> }>;
  };
}

/** Self-contained Controller expression. Native managers retain ownership and arbitration.
 * Absolute reads are non-consuming so multiple Web clients can observe the same work. */
export async function rendererRemoteSession(
  target: RemoteSessionTarget,
  operation: RemoteSessionOperation,
): Promise<unknown> {
  const routing = target.__codexhostHostRoutingV1;
  if (!routing) throw new Error("Desktop remote session routing is unavailable");
  const ids = [...new Set(routing.knownHostIds?.() ?? [])].filter((id) =>
    /^remote-(?:ssh(?:-|:)|control:)/u.test(id),
  );
  const state = (target.__codexhostRemoteSessionsV1 ??= { managers: new WeakMap() });
  if (operation.kind === "hosts") {
    const api = target.__codexhostRendererBindingProbeV1;
    if (!api?.remoteConnections)
      return ids.map((hostId) => ({ hostId, online: !!routing.forHost(hostId) }));
    const configured = await api.remoteConnections({ action: "catalog" });
    const connections = Array.isArray(configured)
      ? (configured as Array<{ hostId: string; displayName: string; autoConnect: boolean }>)
      : [];
    const previous = state.reconnectAttempts;
    // An older Controller's one-shot attempts have unknown outcomes; preserve that guard.
    const attempts = (state.reconnectAttempts =
      previous && !("get" in previous)
        ? new Map([...previous].map((id) => [id, { failures: 0, retryAt: Infinity }]))
        : (previous ?? new Map()));
    return Promise.all(
      [...new Set([...ids, ...connections.map((c) => c.hostId)])].map(async (hostId) => {
        const connection = connections.find((c) => c.hostId === hostId);
        let status = (await api
          .remoteConnections({ action: "state", hostId })
          .catch(() => ({ state: "error" }))) as { state: string };
        if (connection?.autoConnect === false || status.state === "connected")
          attempts.delete(hostId);
        if (connection?.autoConnect && status.state === "disconnected") {
          let attempt = attempts.get(hostId);
          if (!attempt || (!attempt.loading && Date.now() >= attempt.retryAt)) {
            attempt ??= { failures: 0, retryAt: Infinity };
            const current = attempt;
            // Reserve before any asynchronous revalidation; unknown outcomes stay blocked.
            current.retryAt = Infinity;
            attempts.set(hostId, current);
            current.loading = Promise.resolve().then(async () => {
              try {
                const latestStatus = (await api.remoteConnections({ action: "state", hostId })) as {
                  state: string;
                };
                const latest = await api.remoteConnections({ action: "catalog" });
                if (
                  attempts.get(hostId) !== current ||
                  !Array.isArray(latest) ||
                  !latest.some((c) => c.hostId === hostId && c.autoConnect === true) ||
                  latestStatus.state !== "disconnected"
                ) {
                  if (attempts.get(hostId) === current) attempts.delete(hostId);
                  return;
                }
                let acknowledged = false;
                let failureCode: unknown;
                try {
                  await api.remoteConnections({ action: "connect", hostId, enabled: true });
                  acknowledged = true;
                } catch (error) {
                  failureCode = (error as { code?: unknown } | null)?.code;
                }
                const result = (await api.remoteConnections({ action: "state", hostId })) as {
                  state: string;
                  error?: unknown;
                };
                // A transport timeout or arbitrary rejection does not prove the write failed.
                // Only acknowledged native completion or a definite network failure can retry.
                const failed =
                  acknowledged ||
                  [
                    "ECONNREFUSED",
                    "ECONNRESET",
                    "ENETUNREACH",
                    "EHOSTUNREACH",
                    "ENOTFOUND",
                    "EAI_AGAIN",
                  ].includes(String(failureCode));
                if (failed && result.state === "disconnected" && result.error) {
                  current.failures = Math.min(current.failures + 1, 4);
                  current.retryAt =
                    Date.now() + Math.min(30_000, 5_000 * 2 ** (current.failures - 1));
                }
              } catch {
                // Failed observations cannot establish a safe retry outcome.
              } finally {
                delete current.loading;
              }
            });
            attempt = current;
          }
          await attempt.loading;
          status = (await api
            .remoteConnections({ action: "state", hostId })
            .catch(() => ({ state: "error" }))) as { state: string };
        }
        return {
          hostId,
          displayName:
            connection?.displayName ??
            (hostId.startsWith("remote-control:")
              ? "Remote Control"
              : hostId.replace(/^remote-ssh-(?:discovered|codex-managed):/u, "")),
          state: status.state,
          online: status.state === "connected" && !!routing.forHost(hostId),
        };
      }),
    );
  }
  if (!ids.includes(operation.hostId))
    throw new Error("Remote Host is offline or no longer known to Desktop");
  const route = routing.forHost(operation.hostId);
  const manager = route?.manager;
  if (!route || !manager) throw new Error("Remote Host is offline");
  let generation = state.managers.get(route);
  if (!generation) {
    generation = { epoch: crypto.randomUUID(), answered: new Set() };
    state.managers.set(route, generation);
  }
  if ("epoch" in operation && operation.epoch !== generation.epoch)
    throw new Error("Remote connection changed; refresh before operating");
  if (operation.kind === "list")
    return manager.sendRequest("thread/list", {
      cursor: operation.cursor,
      archived: operation.archived,
      limit: 100,
    });
  const threadId = operation.threadId;
  const pendingRequests = async (): Promise<Request[]> => {
    const conversation = (await manager.getConversation?.(threadId)) as
      { requests?: Request[] } | undefined;
    if (routing.forHost(operation.hostId) !== route)
      throw new Error("Remote connection changed during interaction read");
    return Array.isArray(conversation?.requests) ? conversation.requests : [];
  };
  if (operation.kind === "read") {
    // Paginated external history rejects includeTurns=true. Read its header first;
    // native/legacy history keeps the official full-read behavior.
    let result = await manager.sendRequest("thread/read", { threadId, includeTurns: false });
    if (routing.forHost(operation.hostId) !== route)
      throw new Error("Remote connection changed during read");
    const header = result as {
      thread?: { historyMode?: string; modelProvider?: string; cwd?: string };
    };
    if (header.thread?.historyMode === "paginated") {
      const turns: unknown[] = [],
        cursors = new Set<string>();
      let cursor: string | null = null,
        bytes = 0,
        complete = false;
      for (let page = 0; page < 100; page++) {
        if (routing.forHost(operation.hostId) !== route)
          throw new Error("Remote connection changed during read");
        const response = (await manager.sendRequest("thread/turns/list", {
          threadId,
          cursor,
          limit: 50,
          sortDirection: "asc",
          itemsView: "full",
        })) as { data?: unknown[]; nextCursor?: string | null };
        if (
          !Array.isArray(response.data) ||
          (response.nextCursor !== null && typeof response.nextCursor !== "string")
        )
          throw new Error("Invalid remote history page");
        bytes += new TextEncoder().encode(JSON.stringify(response.data)).byteLength;
        if (bytes > 14 * 1024 * 1024) throw new Error("Remote history exceeds the snapshot limit");
        turns.push(...response.data);
        cursor = response.nextCursor;
        if (cursor === null) {
          complete = true;
          break;
        }
        if (cursors.has(cursor)) throw new Error("Remote history cursor repeated");
        cursors.add(cursor);
      }
      if (!complete) throw new Error("Remote history exceeds the page limit");
      result = { ...(result as object), thread: { ...header.thread, turns } };
    } else result = await manager.sendRequest("thread/read", { threadId, includeTurns: true });
    if (routing.forHost(operation.hostId) !== route)
      throw new Error("Remote connection changed during read");
    let metadata: Record<string, unknown> = {};
    if (header.thread?.modelProvider === "codexhost") {
      const cwd = header.thread.cwd;
      try {
        const configuration = (await manager.sendRequest("codexhost/thread/inspect", {
          threadId,
        })) as { owner?: string; harnessId?: string };
        if (routing.forHost(operation.hostId) !== route)
          throw new Error("Remote connection changed during read");
        metadata = { configuration };
        if (configuration.owner === "external" && configuration.harnessId) {
          const harnessId = configuration.harnessId,
            key = JSON.stringify([harnessId, cwd]);
          const cache = (generation.metadata ??= new Map());
          let discovery = cache.get(key);
          if (!discovery || Date.now() >= discovery.retryAt) {
            const loading = Promise.all([
              Promise.resolve().then(() => {
                if (routing.forHost(operation.hostId) !== route)
                  throw new Error("Remote connection changed during read");
                return manager.sendRequest("codexhost/harness/inspect", {
                  harnessId,
                  ...(cwd ? { cwd: cwd } : {}),
                });
              }),
              Promise.resolve()
                .then(() => {
                  if (routing.forHost(operation.hostId) !== route)
                    throw new Error("Remote connection changed during read");
                  return manager.sendRequest("codexhost/harness/plugins/list", {});
                })
                .catch(() => null),
            ]).then(([inspection, catalog]) => {
              if ((inspection as { status?: string } | null)?.status !== "ready")
                throw new Error("Remote Harness discovery is unavailable");
              return {
                inspection,
                harness: (catalog as { plugins?: Array<{ id: string }> } | null)?.plugins?.find(
                  (p) => p.id === harnessId,
                ),
              };
            });
            const attempt = {
              loading,
              failures: discovery?.failures ?? 0,
              retryAt: Infinity,
            };
            void loading.catch(() => {
              attempt.failures = Math.min(attempt.failures + 1, 4);
              attempt.retryAt = Date.now() + Math.min(30_000, 5_000 * 2 ** (attempt.failures - 1));
            });
            discovery = attempt;
            // A Desktop can visit many workspaces during one connection lifetime.
            if (cache.size >= 64 && !cache.has(key)) {
              const oldest = cache.keys().next().value;
              if (oldest !== undefined) cache.delete(oldest);
            }
            cache.set(key, discovery);
          }
          metadata = { ...metadata, ...(await discovery.loading) };
        }
      } catch {
        /* Optional controls never prevent reading history; failed discovery stays bounded. */
      }
    }
    if (routing.forHost(operation.hostId) !== route)
      throw new Error("Remote connection changed during read");
    const requests = await pendingRequests();
    return {
      result,
      ...metadata,
      epoch: generation.epoch,
      interactionsAvailable:
        !!manager.getConversation &&
        !!manager.replyWithCommandExecutionApprovalDecision &&
        !!manager.replyWithFileChangeApprovalDecision,
      requests: requests.filter(
        (request) =>
          (request.params.threadId ?? request.params.conversationId) === threadId &&
          !generation.answered.has(JSON.stringify([threadId, request.id])),
      ),
    };
  }
  if (operation.kind === "respond") {
    const key = JSON.stringify([threadId, operation.requestId]);
    const request = (await pendingRequests()).find(
      (item) =>
        item.id === operation.requestId &&
        (item.params.threadId ?? item.params.conversationId) === threadId,
    );
    if (
      !request ||
      generation.answered.has(key) ||
      !manager.replyWithCommandExecutionApprovalDecision ||
      !manager.replyWithFileChangeApprovalDecision
    )
      throw new Error("Native interaction is no longer pending");
    if (
      !["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(
        request.method,
      ) ||
      !["accept", "decline", "cancel"].includes(String(operation.result.decision)) ||
      Object.keys(operation.result).some((key) => key !== "decision")
    )
      throw new Error("Unsupported native interaction response");
    // Mark before dispatch: an exception after dispatch has an unknown outcome, never replay.
    generation.answered.add(key);
    const respond =
      request.method === "item/commandExecution/requestApproval"
        ? manager.replyWithCommandExecutionApprovalDecision
        : manager.replyWithFileChangeApprovalDecision;
    await respond.call(manager, threadId, request.id, String(operation.result.decision));
    return { accepted: true };
  }
  switch (operation.kind) {
    case "configure": {
      const configuration = (await manager.sendRequest("codexhost/thread/inspect", {
        threadId,
      })) as { owner?: string };
      if (routing.forHost(operation.hostId) !== route)
        throw new Error("Remote connection changed during configuration");
      if (configuration.owner !== "external")
        throw new Error("Remote Thread configuration is unavailable");
      let method: string, params: Record<string, unknown>;
      if (operation.modelId !== undefined) {
        method = "codexhost/thread/model/select";
        params = { threadId, model: { id: operation.modelId } };
      } else if (operation.thinkingOptionId !== undefined) {
        method = "codexhost/thread/thinking/select";
        params = { threadId, thinkingOptionId: operation.thinkingOptionId };
      } else {
        method = "codexhost/thread/permission-mode/select";
        params = { threadId, permissionModeId: operation.permissionModeId };
      }
      // An unconfirmed mutation is never replayed. Rediscover controls after any outcome.
      try {
        const result = await manager.sendRequest(method, params);
        if (routing.forHost(operation.hostId) !== route)
          throw new Error("Remote connection changed during configuration");
        return result;
      } finally {
        generation.metadata?.clear();
      }
    }
    case "prompt":
      await manager.sendRequest("thread/resume", { threadId });
      if (routing.forHost(operation.hostId) !== route)
        throw new Error("Remote connection changed during resume");
      return manager.sendRequest("turn/start", {
        threadId,
        input: [{ type: "text", text: operation.text, text_elements: [] }],
        ...(operation.requestId ? { clientUserMessageId: operation.requestId } : {}),
      });
    case "interrupt":
      return manager.sendRequest("turn/interrupt", { threadId, turnId: operation.turnId });
    case "rename":
      return manager.sendRequest("thread/name/set", { threadId, name: operation.name });
    case "archive":
      return manager.sendRequest(operation.archived ? "thread/archive" : "thread/unarchive", {
        threadId,
      });
  }
}
