/** Web SSE transport for page-owned client entry reconciliation and rebuilt code replacement. */
import type { Context } from "@deepseek-ai/cordis";
import type { PluginsEventParseResult } from "../events.ts";
import { EVENTS_ROUTE, parsePluginsEventFrame } from "../events.ts";

export type { PluginsEventFrame } from "../events.ts";

/** Cordis plugin name. */
export const name = "client-hmr";

/** Required service: the client module system whose entry controller handles received frames. */
export const inject = ["modules"];

/**
 * Forward graph snapshots and rebuilds to the page's shared serial controller.
 * @param ctx - Plugin context with the client module system.
 */
export function apply(ctx: Context): void {
  const entries = ctx.modules.entries;
  const handle = (frame: Extract<PluginsEventParseResult, { kind: "frame" }>["frame"]): void => {
    if (frame.type === "shell") {
      location.reload();
      return;
    }
    const run =
      frame.type === "graph"
        ? Promise.resolve().then(() => entries.sync(frame.graph))
        : entries.reload(frame.id, frame.rev);
    void run.catch((error: unknown) => {
      ctx.logger.error(error);
    });
  };

  ctx.effect(() => {
    const source = new EventSource(EVENTS_ROUTE);
    const receive = (event: MessageEvent<string>): void => {
      let value: unknown;
      try {
        value = JSON.parse(event.data) as unknown;
      } catch {
        // Wire boundary: a malformed transport frame is dropped loudly.
        ctx.logger.warn(`client-hmr: unparseable event frame: ${event.data}`);
        return;
      }
      const parsed = parsePluginsEventFrame(value);
      if (parsed.kind === "invalid") {
        ctx.logger.warn(`client-hmr: invalid event frame: ${event.data}`);
      } else if (parsed.kind === "frame") {
        handle(parsed.frame);
      }
    };
    source.addEventListener("message", receive);
    // CodexHost's static shell has a separate development-only reload channel;
    // graph and rebuilt delivery remain entirely on the official transport.
    const shell = (globalThis as { __CODEXHOST_DEV_WEB_UI__?: boolean }).__CODEXHOST_DEV_WEB_UI__
      ? new EventSource("plugins/shell-events")
      : undefined;
    shell?.addEventListener("message", receive);
    return () => {
      source.close();
      shell?.close();
    };
  }, "client-hmr: event source");
}
