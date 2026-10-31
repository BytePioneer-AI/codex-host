/**
 * Development reload channel for a Web server composed from Web UI sources (`--dev-web-ui`).
 *
 * Polls every composed client bundle and the Vite shell document, and serves the `/plugins/events`
 * SSE channel that the imported `@deepseek-ai/dsh-client-hmr` browser plugin subscribes to. A
 * rebuilt plugin is swapped into open pages in place; a rebuilt shell reloads them. This replaces
 * the DSH Host half of that package, which depends on the DSH Web server this gateway does not run.
 */

import { statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { BootGraph, WebAssets } from "./web-assets.ts";

/** SSE endpoint the browser plugin opens (document-relative `plugins/events`). */
export const HMR_EVENTS_PATH = "/plugins/events";

/** Wire frames of `@deepseek-ai/dsh-client-hmr` (`src/events.ts` in that package). */
type HmrFrame =
  | { type: "graph"; graph: BootGraph }
  | { type: "rebuilt"; id: string; rev: string }
  | { type: "shell" };

interface WatchedFile {
  readonly path: string;
  /** Stat key last acted on. */
  settled: string | undefined;
  /** Changed stat key waiting one interval to prove the write finished. */
  pending: string | undefined;
  readonly changed: () => void;
}

function statKey(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${String(stat.mtimeMs)}:${String(stat.ctimeMs)}:${String(stat.size)}`;
  } catch {
    // A bundle being rewritten may be briefly absent; the next poll sees it again.
    return undefined;
  }
}

export class WebHmr {
  private readonly connections = new Set<ServerResponse>();
  private readonly watched: WatchedFile[];
  private readonly timer: NodeJS.Timeout;

  /**
   * Start polling at once; the current bytes are the baseline, so startup sends no reloads.
   * @param assets - source-composed assets whose bundles and shell document are watched.
   * @param intervalMs - stat poll interval. A change is published once it holds for one interval.
   */
  constructor(
    private readonly assets: WebAssets,
    intervalMs = 250,
  ) {
    const watch = (path: string, changed: () => void): WatchedFile => ({
      path,
      settled: statKey(path),
      pending: undefined,
      changed,
    });
    this.watched = [
      ...assets.bundles().map(({ id, path }) =>
        watch(path, () => {
          const rev = assets.rebuilt(id);
          if (rev === undefined) return;
          console.log(`[web-hmr] reloading ${id}`);
          this.broadcast({ type: "rebuilt", id, rev });
        }),
      ),
      watch(assets.shellIndexPath, () => {
        if (!assets.shellRebuilt()) return;
        console.log("[web-hmr] shell rebuilt; reloading pages");
        this.broadcast({ type: "shell" });
      }),
    ];
    this.timer = setInterval(() => {
      this.poll();
    }, intervalMs);
    this.timer.unref();
  }

  /** Open one SSE stream; the current graph lets a reconnecting page catch up on missed rebuilds. */
  connect(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(": connected\n\n");
    response.write(sseData({ type: "graph", graph: this.assets.graph }));
    this.connections.add(response);
    response.on("close", () => {
      this.connections.delete(response);
    });
  }

  close(): void {
    clearInterval(this.timer);
    for (const response of this.connections) response.destroy();
    this.connections.clear();
  }

  private poll(): void {
    for (const file of this.watched) {
      const key = statKey(file.path);
      if (key === file.settled) {
        file.pending = undefined;
        continue;
      }
      if (key === undefined || key !== file.pending) {
        file.pending = key;
        continue;
      }
      file.pending = undefined;
      try {
        file.changed();
        file.settled = key;
      } catch (error) {
        // Leave the key unsettled so the next completed write retries.
        console.warn(`[web-hmr] ${file.path}:`, error instanceof Error ? error.message : error);
      }
    }
  }

  private broadcast(frame: HmrFrame): void {
    const line = sseData(frame);
    for (const response of this.connections) response.write(line);
  }
}

function sseData(frame: HmrFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}
