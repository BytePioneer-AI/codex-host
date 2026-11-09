/** Development-only reload bridge for the statically linked Vite shell. Plugin HMR is owned by DSH. */
import { statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebAssets } from "./web-assets.ts";

export const SHELL_EVENTS_PATH = "/plugins/shell-events";

function statKey(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${String(stat.mtimeMs)}:${String(stat.ctimeMs)}:${String(stat.size)}`;
  } catch {
    return undefined;
  }
}

export class WebShellReload {
  private readonly connections = new Set<ServerResponse>();
  private readonly timer: NodeJS.Timeout;

  constructor(assets: WebAssets, intervalMs = 250) {
    let settled = statKey(assets.shellIndexPath);
    let pending: string | undefined;
    this.timer = setInterval(() => {
      const key = statKey(assets.shellIndexPath);
      if (key === settled) {
        pending = undefined;
        return;
      }
      if (key === undefined || key !== pending) {
        pending = key;
        return;
      }
      pending = undefined;
      try {
        if (assets.shellRebuilt()) {
          for (const response of this.connections) response.write('data: {"type":"shell"}\n\n');
        }
        settled = key;
      } catch (error) {
        // A shell build can replace the document between the stat and read.
        console.warn("[web-shell]", error);
      }
    }, intervalMs);
    this.timer.unref();
  }

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
    this.connections.add(response);
    response.on("close", () => this.connections.delete(response));
  }

  close(): void {
    clearInterval(this.timer);
    for (const response of this.connections) response.destroy();
    this.connections.clear();
  }
}
