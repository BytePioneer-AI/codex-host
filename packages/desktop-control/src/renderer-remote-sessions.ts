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
    managers: WeakMap<object, { epoch: string; answered: Set<string> }>;
    reconnectAttempts?: Set<string>;
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
    const attempts = (state.reconnectAttempts ??= new Set<string>());
    return Promise.all(
      [...new Set([...ids, ...connections.map((c) => c.hostId)])].map(async (hostId) => {
        const connection = connections.find((c) => c.hostId === hostId);
        let status = (await api
          .remoteConnections({ action: "state", hostId })
          .catch(() => ({ state: "error" }))) as { state: string };
        if (connection?.autoConnect === false) attempts.delete(hostId);
        if (connection?.autoConnect && status.state === "disconnected" && !attempts.has(hostId)) {
          // Restore an already-enabled native connection once per Desktop lifetime.
          // Never enable a user-disabled connection or replay an unknown outcome.
          attempts.add(hostId);
          await api
            .remoteConnections({ action: "connect", hostId, enabled: true })
            .catch(() => undefined);
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
  if (operation.kind === "list") {
    const page = (await manager.sendRequest("thread/list", {
      cursor: operation.cursor,
      archived: operation.archived,
      limit: 100,
    })) as { data: Array<{ id: string; modelProvider: string }>; nextCursor: string | null };
    const threadIds = page.data
      .filter((row) => row.modelProvider === "codexhost")
      .map((row) => row.id);
    if (!threadIds.length) return page;
    // Ownership is independent of model/provider names, and never requires history reads.
    const [ownership, catalog] = await Promise.all([
      Promise.resolve(manager.sendRequest("codexhost/thread/ownership/list", { threadIds })).catch(
        () => null,
      ),
      Promise.resolve(manager.sendRequest("codexhost/harness/plugins/list", {})).catch(() => null),
    ]);
    if (routing.forHost(operation.hostId) !== route)
      throw new Error("Remote connection changed during ownership read");
    const owners = (
      ownership as {
        threads?: Array<{ threadId: string; owner: string; harnessId?: string }>;
      } | null
    )?.threads;
    const plugins = (catalog as { plugins?: Array<{ id: string; name: string }> } | null)?.plugins;
    return {
      ...page,
      data: page.data.map((row) => {
        const owner = Array.isArray(owners)
          ? owners.find((entry) => entry?.threadId === row.id && entry.owner === "external")
          : undefined;
        const id = owner?.harnessId;
        if (row.modelProvider !== "codexhost" || typeof id !== "string" || !id) return row;
        const plugin = Array.isArray(plugins)
          ? plugins.find((entry) => entry?.id === id)
          : undefined;
        const name = typeof plugin?.name === "string" && plugin.name ? plugin.name : id;
        return { ...row, harnessIdentity: { id, name } };
      }),
    };
  }
  const threadId = operation.threadId;
  if (operation.kind === "turns") {
    const page = await manager.sendRequest("thread/turns/list", {
      threadId,
      cursor: operation.cursor,
      limit: 5,
      sortDirection: "desc",
      itemsView: "full",
    });
    if (routing.forHost(operation.hostId) !== route)
      throw new Error("Remote connection changed during history read");
    return page;
  }
  const pendingRequests = async (): Promise<Request[]> => {
    const conversation = (await manager.getConversation?.(threadId)) as
      { requests?: Request[] } | undefined;
    if (routing.forHost(operation.hostId) !== route)
      throw new Error("Remote connection changed during interaction read");
    return Array.isArray(conversation?.requests) ? conversation.requests : [];
  };
  if (operation.kind === "read") {
    let result;
    try {
      result = await manager.sendRequest("thread/read", {
        threadId,
        includeTurns: operation.metadataOnly !== true,
      });
    } catch (error) {
      if (
        operation.metadataOnly ||
        !(error instanceof Error) ||
        !error.message.includes("Paginated External Threads require thread/turns/list")
      )
        throw error;
      result = await manager.sendRequest("thread/read", { threadId, includeTurns: false });
    }
    if (routing.forHost(operation.hostId) !== route)
      throw new Error("Remote connection changed during read");
    const requests = await pendingRequests();
    return {
      result,
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
    case "prompt":
      // Resuming is required before a native turn, but Web already reads history
      // in pages. Returning every old Turn here can overwhelm the shared native
      // connection before the new message is even dispatched.
      await manager.sendRequest("thread/resume", { threadId, excludeTurns: true });
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
