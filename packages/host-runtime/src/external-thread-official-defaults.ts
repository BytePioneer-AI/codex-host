import type { JsonObject } from "@codexhost/protocol-core";

/**
 * Official per-Thread requests that clients without the codexhost renderer (such as the ChatGPT
 * iOS app over SSH) send around every open or send. External Threads have no official
 * attachments, and their permissions belong to the Harness, so these answer
 * with the empty official response shape rather than an error that aborts the client's flow.
 * `thread/settings/update` is acknowledged without being applied; the Harness keeps its own
 * permission mode.
 */
const EMPTY_RESULTS: ReadonlyMap<string, () => JsonObject> = new Map([
  ["thread/attachment/list", () => ({ data: [], nextCursor: null })],
  ["thread/settings/update", () => ({})],
]);

export function externalThreadEmptyOfficialResult(method: string): JsonObject | undefined {
  return EMPTY_RESULTS.get(method)?.();
}
