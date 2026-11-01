import type { RendererMessageTarget } from "./renderer-manual-compaction.js";
import type { RendererModelClient } from "./renderer-model-client.js";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const SYNC_TIMEOUT_MS = 2_000;

/** Desktop's native persisted-atom channel, not storage on a capnweb Manager stub. */
export function restoreRpcThreadReferenceCapability(
  client: RendererModelClient,
  messages: RendererMessageTarget | null,
  isCurrent: () => boolean,
): RendererModelClient {
  if (!record(messages) || !record(messages.electronBridge)) return client;
  const bridge = messages.electronBridge;
  const send = bridge.sendMessageFromView;
  if (typeof send !== "function") return client;
  const inspect = client.inspectThread.bind(client);
  const checked = new Set<string>();
  const isMissing = (key: string): Promise<boolean> =>
    new Promise((resolve) => {
      const finish = (missing: boolean): void => {
        clearTimeout(timer);
        messages.removeEventListener("message", listener);
        resolve(missing);
      };
      const listener: Parameters<RendererMessageTarget["addEventListener"]>[1] = (event) => {
        if (event.source != null && event.source !== messages) return;
        const message = event.data;
        if (!record(message) || message.type !== "persisted-atom-sync" || !record(message.state))
          return;
        finish(!Object.hasOwn(message.state, key));
      };
      const timer = setTimeout(() => finish(false), SYNC_TIMEOUT_MS);
      messages.addEventListener("message", listener);
      try {
        Promise.resolve(
          send.call(bridge, { type: "persisted-atom-sync-request", responsePriority: "critical" }),
        ).catch(() => finish(false));
      } catch {
        finish(false);
      }
    });
  const inspectThread: RendererModelClient["inspectThread"] = async (input) => {
    if (!isCurrent() || checked.has(input.threadId)) return inspect(input);
    // Reserve before the asynchronous snapshot so concurrent inspections cannot poll.
    checked.add(input.threadId);
    const key = `thread-reference-capability:${input.threadId}`;
    if (!(await isMissing(key)) || !isCurrent()) return inspect(input);
    let proven = true;
    const result = await inspect({ ...input, includeReferenceCapability: true }).catch(() => {
      proven = false;
      return inspect(input);
    });
    if (
      proven &&
      result.owner === "codex" &&
      result.supportsThreadReferences === true &&
      isCurrent() &&
      (await isMissing(key)) &&
      isCurrent()
    ) {
      try {
        await send.call(bridge, {
          type: "persisted-atom-update",
          key,
          value: true,
          deleted: false,
        });
      } catch {
        // Ownership inspection succeeds even when native persistence is unavailable.
      }
    }
    return result;
  };
  return Object.freeze({ ...client, inspectThread });
}
