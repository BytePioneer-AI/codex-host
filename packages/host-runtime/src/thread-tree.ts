import type { JsonObject, JsonRpcRequest } from "@codexhost/protocol-core";
import {
  clientThreadTreeReadParamsSchema,
  type ClientThreadTree,
} from "@codexhost/shared-contracts";
import type { ExternalThreadRepository } from "./external-thread-repository.js";
import { rpcEnvelope, errorMessage } from "./desktop-rpc.js";
import { originClientName } from "./external-client-origin.js";

/** Sidebar parents are delegation parents, excluding pins and external client origins. */
export class ThreadTree {
  constructor(
    private readonly repository: ExternalThreadRepository,
    private readonly pinnedThreadIds: () => Promise<readonly string[]>,
  ) {}

  async read(): Promise<ClientThreadTree> {
    const delegations = await this.repository.listDelegations();
    const pinned = new Set(delegations.length ? await this.pinnedThreadIds() : []);
    return {
      parents: Object.fromEntries(
        delegations
          .filter(
            (entry) =>
              !pinned.has(entry.childHostThreadId) &&
              originClientName(entry.parentHostThreadId) === undefined,
          )
          .map((entry) => [entry.childHostThreadId, entry.parentHostThreadId]),
      ),
    };
  }

  async handle(request: JsonRpcRequest): Promise<JsonObject> {
    const parsed = clientThreadTreeReadParamsSchema.safeParse(request.params ?? {});
    if (!parsed.success)
      return rpcEnvelope(request, {
        error: {
          code: -32602,
          message: "Invalid Thread tree parameters.",
          data: { code: "INVALID_ARGUMENT" },
        },
      });
    try {
      return rpcEnvelope(request, { result: await this.read() });
    } catch (error) {
      return rpcEnvelope(request, {
        error: {
          code: -32603,
          message: errorMessage(error),
          data: { code: "INTERNAL_ERROR" },
        },
      });
    }
  }
}
