import { routeDelegationRequest } from "./delegation-control-server.js";
import {
  DelegationControlError,
  type DelegationControlApi,
  type DelegationWatchApi,
} from "./delegation-types.js";
import type { ClientEventLog } from "./external-client-events.js";
import { clientOrigin, originClientName } from "./external-client-origin.js";
import type {
  ExternalClientCall,
  ExternalClientRouter,
  ExternalClientStreamHandler,
} from "./external-client-server.js";
import type { ExternalClientRegistry } from "./external-clients.js";

const MAX_POLL_MS = 60_000;
const MAX_EVENTS_PER_READ = 100;
const HEARTBEAT_MS = 25_000;

/** A client may name only itself where an identifier stands for the caller. */
function ownOrigin(client: string, value: unknown, field: string): string {
  if (value === undefined) return clientOrigin(client);
  const other = typeof value === "string" ? originClientName(value) : undefined;
  if (other !== undefined && other !== client)
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `${field} may name only the calling client`,
    );
  return value as string;
}

/** Applies the caller's identity: work and watches without a parent or target belong to the client. */
function forClient(
  client: string,
  route: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (route === "/v1/delegate/start")
    return { ...body, parentThreadId: ownOrigin(client, body.parentThreadId, "parentThreadId") };
  if (route === "/v1/thread/watch")
    return { ...body, notifyThreadId: ownOrigin(client, body.notifyThreadId, "notifyThreadId") };
  return body;
}

function nonNegativeInteger(
  value: unknown,
  name: string,
  fallback: number,
  maximum?: number,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (maximum !== undefined && (value as number) > maximum)
  )
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `${name} must be a non-negative integer${maximum !== undefined ? ` no greater than ${maximum}` : ""}`,
    );
  return value as number;
}

/** Events after a cursor; waits up to timeoutMs for the first one when none is there yet. */
async function pollEvents(events: ClientEventLog, client: string, body: Record<string, unknown>) {
  const after = nonNegativeInteger(body.after, "after", 0);
  const timeoutMs = nonNegativeInteger(body.timeoutMs, "timeoutMs", 0, MAX_POLL_MS);
  const limit =
    nonNegativeInteger(body.limit, "limit", MAX_EVENTS_PER_READ, MAX_EVENTS_PER_READ) ||
    MAX_EVENTS_PER_READ;
  const page = await events.read(client, after, limit);
  if (page.events.length > 0 || timeoutMs === 0) return page;
  await events.waitForEvent(client, timeoutMs);
  return events.read(client, after, limit);
}

/** The delegation routes as an external client sees them, plus event polling. */
export function externalClientRouter(handlers: {
  api: DelegationControlApi;
  watchApi?: DelegationWatchApi;
  events?: ClientEventLog;
}): ExternalClientRouter {
  return async (call, route, body) => {
    if (route === "/v1/events/poll") {
      if (!handlers.events)
        throw new DelegationControlError("INVALID_ARGUMENT", "This Runtime keeps no client events");
      return pollEvents(handlers.events, call.client, body);
    }
    return routeDelegationRequest(handlers, route, forClient(call.client, route, body));
  };
}

function writeEvent(call: ExternalClientCall, id: number, event: string, data: unknown): void {
  call.response.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Server-sent events: replays everything after Last-Event-ID (or ?after=), then
 * pushes new events. A heartbeat keeps the connection open and ends it once the
 * client has been removed.
 */
export function externalClientEventStream(
  events: ClientEventLog,
  clients: ExternalClientRegistry,
): ExternalClientStreamHandler {
  return async (call, url) => {
    if (call.request.method !== "GET")
      throw new DelegationControlError("INVALID_ARGUMENT", "GET is required");
    const header = call.request.headers["last-event-id"];
    const raw =
      (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get("after") ?? "0";
    let cursor = /^[0-9]+$/u.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(cursor))
      throw new DelegationControlError("INVALID_ARGUMENT", "Last-Event-ID must be an event id");
    const closed = new AbortController();
    call.request.on("close", () => closed.abort());
    call.response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    call.response.write(": connected\n\n");
    while (!closed.signal.aborted) {
      let page;
      try {
        page = await events.read(call.client, cursor, MAX_EVENTS_PER_READ);
      } catch (error) {
        if (error instanceof DelegationControlError) {
          writeEvent(call, cursor, "error", {
            code: error.code,
            message: error.message,
            details: error.details,
          });
          break;
        }
        throw error;
      }
      for (const event of page.events) writeEvent(call, event.id, event.type, event);
      cursor = page.cursor;
      if (page.events.length === MAX_EVENTS_PER_READ) continue;
      await events.waitForEvent(call.client, HEARTBEAT_MS, closed.signal);
      if (closed.signal.aborted) break;
      if (!(await clients.has(call.client))) break;
      call.response.write(": ping\n\n");
    }
    call.response.end();
  };
}
