import type { RendererHostRouting } from "@codexhost/desktop-control/renderer-bindings";
import {
  DELEGATION_READ_METHOD,
  DESKTOP_THREAD_READ_METHOD,
  DESKTOP_THREAD_READ_REPLY_METHOD,
  desktopThreadReadRequestSchema,
  delegationThreadSnapshotSchema,
  isDelegationThreadReadMiss,
  REMOTE_THREAD_REPLY_MAX_BYTES,
  type DesktopThreadReadReply,
} from "@codexhost/shared-contracts";
import type { RendererMessageTarget } from "./renderer-manual-compaction.js";

/** A single-hop callback: read this Desktop's local Host, never the CLI fallback route. */
export function installRendererDesktopThreadRead(
  messages: RendererMessageTarget | null,
  readRouting: () => RendererHostRouting | undefined,
): () => void {
  if (!messages) return () => undefined;
  let disposed = false;
  const listener: Parameters<RendererMessageTarget["addEventListener"]>[1] = (event) => {
    if (event.source != null && event.source !== messages) return;
    const message = event.data;
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "mcp-notification" ||
      !("method" in message) ||
      message.method !== DESKTOP_THREAD_READ_METHOD ||
      !("hostId" in message) ||
      typeof message.hostId !== "string" ||
      !("params" in message)
    )
      return;
    const parsed = desktopThreadReadRequestSchema.safeParse(message.params);
    if (!parsed.success) return;
    const routing = readRouting();
    const origin = routing?.forHost(message.hostId);
    const local = routing?.forHost("local");
    if (!origin || !local) return;
    const { requestId, input } = parsed.data;
    void (async () => {
      let reply: DesktopThreadReadReply;
      try {
        const result = delegationThreadSnapshotSchema.parse(
          await local.manager.sendRequest(DELEGATION_READ_METHOD, input),
        );
        if (result.threadId !== input.threadId)
          throw new Error("Local Host returned a different Thread");
        reply = { requestId, result };
        if (
          new TextEncoder().encode(JSON.stringify(reply)).byteLength > REMOTE_THREAD_REPLY_MAX_BYTES
        ) {
          reply = {
            requestId,
            error: {
              code: "RESPONSE_TOO_LARGE",
              message:
                "Desktop Thread reply exceeds the response byte limit; request fewer messages",
            },
          };
        }
      } catch (error) {
        reply = {
          requestId,
          error: {
            code: isDelegationThreadReadMiss(error) ? "THREAD_NOT_FOUND" : "INTERNAL_ERROR",
            message: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
          },
        };
      }
      if (!disposed && readRouting()?.forHost(origin.hostId) === origin) {
        await origin.manager.sendRequest(DESKTOP_THREAD_READ_REPLY_METHOD, reply);
      }
    })().catch(() => undefined); // A disconnected requester is handled by its bounded read.
  };
  messages.addEventListener("message", listener);
  return () => {
    disposed = true;
    messages.removeEventListener("message", listener);
  };
}
