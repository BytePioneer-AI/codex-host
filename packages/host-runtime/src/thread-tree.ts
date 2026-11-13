import type { JsonObject, JsonRpcRequest } from "@codexhost/protocol-core";
import {
  clientThreadTreeReadParamsSchema,
  clientThreadTreePlaceParamsSchema,
  type ClientThreadTree,
} from "@codexhost/shared-contracts";
import type { ExternalThreadRepository } from "./external-thread-repository.js";
import type { SharedThreadBridge } from "./shared-thread-bridge.js";
import { rpcEnvelope, errorMessage } from "./desktop-rpc.js";
import { originClientName } from "./external-client-origin.js";

class ThreadTreeArgumentError extends Error {}

/** Display parents never alter delegation records, routing or native Subagent ancestry. */
export class ThreadTree {
  private operations: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly repository: ExternalThreadRepository,
    private readonly requestOfficial: (method: string, params: JsonObject) => Promise<JsonObject>,
    private readonly shared?: SharedThreadBridge,
  ) {}

  async read(): Promise<ClientThreadTree> {
    const [delegations, placements] = await Promise.all([
      this.repository.listDelegations(),
      this.repository.listThreadTreePlacements(),
    ]);
    const parents = new Map<string, string>(
      delegations
        .filter((entry) => originClientName(entry.parentHostThreadId) === undefined)
        .map((entry) => [entry.childHostThreadId, entry.parentHostThreadId]),
    );
    for (const entry of placements) {
      if (entry.parentThreadId === null) parents.delete(entry.hostThreadId);
      else parents.set(entry.hostThreadId, entry.parentThreadId);
    }
    return { parents: Object.fromEntries(parents) };
  }

  private async validateThread(threadId: string): Promise<void> {
    const record = await this.repository.find(threadId);
    if (record) {
      if (record.state !== "ready" || record.subagent)
        throw new ThreadTreeArgumentError("Choose a started Thread that is not a Subagent.");
      return;
    }
    let response: JsonObject;
    try {
      const params = { threadId, includeTurns: false };
      response =
        this.shared && (await this.shared.ownership([threadId])).has(threadId)
          ? await this.shared.request("thread/read", params)
          : await this.requestOfficial("thread/read", params);
    } catch {
      throw new ThreadTreeArgumentError("Thread ownership could not be confirmed on this Host.");
    }
    const thread = (response.result as JsonObject | undefined)?.thread as JsonObject | undefined;
    if (response.error || !thread || thread.id !== threadId)
      throw new ThreadTreeArgumentError("Thread ownership could not be confirmed on this Host.");
    const source = thread.source;
    if (typeof source === "object" && source !== null && "subAgent" in source)
      throw new ThreadTreeArgumentError("Subagents cannot be placed in the Thread tree.");
  }

  place(threadId: string, parentThreadId: string | null): Promise<ClientThreadTree> {
    const next = this.operations.then(async () => {
      await this.validateThread(threadId);
      if (parentThreadId !== null) await this.validateThread(parentThreadId);
      const parents = new Map(Object.entries((await this.read()).parents));
      const visited = new Set<string>();
      for (
        let id: string | undefined = parentThreadId ?? undefined;
        id !== undefined;
        id = parents.get(id)
      ) {
        if (id === threadId || visited.has(id))
          throw new ThreadTreeArgumentError(
            "A Thread cannot be placed under itself or its descendants.",
          );
        visited.add(id);
      }
      await this.repository.setThreadTreePlacement(threadId, parentThreadId);
      return this.read();
    });
    this.operations = next.catch(() => undefined);
    return next;
  }

  async handle(request: JsonRpcRequest, changed: (threadId: string) => void): Promise<JsonObject> {
    const placing = request.method === "codexhost/thread/tree/place";
    const change = placing
      ? clientThreadTreePlaceParamsSchema.safeParse(request.params ?? {})
      : undefined;
    const parsed = change ?? clientThreadTreeReadParamsSchema.safeParse(request.params ?? {});
    try {
      if (!parsed.success) throw new ThreadTreeArgumentError("Invalid Thread tree parameters.");
      const placement = change?.success ? change.data : undefined;
      const result = placement
        ? await this.place(placement.threadId, placement.parentThreadId)
        : await this.read();
      if (placement) changed(placement.threadId);
      return rpcEnvelope(request, { result });
    } catch (error) {
      const invalid = error instanceof ThreadTreeArgumentError;
      return rpcEnvelope(request, {
        error: {
          code: invalid ? -32602 : -32603,
          message: errorMessage(error),
          data: { code: invalid ? "INVALID_ARGUMENT" : "INTERNAL_ERROR" },
        },
      });
    }
  }
}
