import type { RendererModelClient } from "./renderer-model-client.js";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Backfill missing native UI metadata only after the owning Host proves support. */
export function restoreThreadReferenceCapability(
  client: RendererModelClient,
  manager: unknown,
  isCurrent: () => boolean,
): RendererModelClient {
  if (!record(manager) || !record(manager.storage)) return client;
  const storage = manager.storage;
  const read = storage.readValue;
  const write = storage.writeValue;
  if (typeof read !== "function" || typeof write !== "function") return client;
  const inspect = client.inspectThread.bind(client);
  const checked = new Set<string>();
  const inspectThread: RendererModelClient["inspectThread"] = async (input) => {
    const key = `thread-reference-capability:${input.threadId}`;
    if (!isCurrent() || checked.has(input.threadId) || read.call(storage, key) !== undefined) {
      return inspect(input);
    }
    checked.add(input.threadId);
    // Older Hosts reject the optional field. Fall back once to normal inspection;
    // a missing capability must never break ownership or trigger polling.
    const result = await inspect({ ...input, includeReferenceCapability: true }).catch(() =>
      inspect(input),
    );
    if (
      result.owner === "codex" &&
      result.supportsThreadReferences === true &&
      isCurrent() &&
      read.call(storage, key) === undefined
    ) {
      try {
        write.call(storage, key, true);
      } catch {
        // Native persistence is optional; preserve successful ownership inspection.
      }
    }
    return result;
  };
  return Object.freeze({ ...client, inspectThread });
}
