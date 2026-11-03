import { routeDelegationRequest } from "./delegation-control-server.js";
import {
  DelegationControlError,
  type DelegationControlApi,
  type DelegationWatchApi,
} from "./delegation-types.js";
import { clientOrigin, originClientName } from "./external-client-origin.js";
import type { ExternalClientRouter } from "./external-client-server.js";

/** Applies the caller's identity to a request; a client can act only as itself. */
function forClient(
  client: string,
  route: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (route !== "/v1/delegate/start") return body;
  const parent = body.parentThreadId;
  if (parent === undefined) return { ...body, parentThreadId: clientOrigin(client) };
  const other = typeof parent === "string" ? originClientName(parent) : undefined;
  if (other !== undefined && other !== client)
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "A client can start work only under its own origin",
    );
  return body;
}

/** The delegation routes as an external client sees them. */
export function externalClientRouter(handlers: {
  api: DelegationControlApi;
  watchApi?: DelegationWatchApi;
}): ExternalClientRouter {
  return async (call, route, body) =>
    routeDelegationRequest(handlers, route, forClient(call.client, route, body));
}
