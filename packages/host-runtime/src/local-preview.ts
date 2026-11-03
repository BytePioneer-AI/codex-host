import { randomUUID } from "node:crypto";
import { createReadStream, watch as watchDirectory, type FSWatcher } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { DelegationControlError } from "./delegation-types.js";

const RELOAD_PATH = "/__codexhost_preview/reload";
const RELOAD_DEBOUNCE_MS = 300;
const DEFAULT_MAX_PREVIEWS = 8;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

/** Reloads the page when the preview server reports a change. */
const RELOAD_SCRIPT = `<script>(()=>{const s=new EventSource(${JSON.stringify(RELOAD_PATH)});s.onmessage=()=>location.reload();})();</script>`;

export interface LocalPageHandle {
  show(): Promise<void>;
  close(): Promise<void>;
}

export interface PreviewOpeners {
  /** Opens a loopback root URL in Codex's built-in browser under the visible local task. */
  page?: (url: string) => Promise<LocalPageHandle>;
  /** Opens a loopback root URL in the system browser. */
  browser?: (url: URL) => Promise<void>;
}

export type PreviewOpened = "builtInBrowser" | "systemBrowser";

export interface PreviewEntry {
  previewId: string;
  path: string;
  url: string;
  threadId?: string;
}

export interface PreviewOpenResult extends PreviewEntry {
  opened: PreviewOpened;
  /** Why the built-in browser was not used. */
  reason?: string;
}

interface Preview extends PreviewEntry {
  file: string;
  root: string;
  server: Server;
  watcher: FSWatcher | undefined;
  listeners: Set<ServerResponse>;
  page: LocalPageHandle | undefined;
  usedAt: number;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function injectReload(html: string): string {
  const close = html.toLowerCase().lastIndexOf("</body>");
  return close >= 0
    ? `${html.slice(0, close)}${RELOAD_SCRIPT}${html.slice(close)}`
    : `${html}${RELOAD_SCRIPT}`;
}

/**
 * Serves one HTML file's directory read-only on a loopback port and shows it in
 * Codex's built-in browser; edits under the directory reload the page. The file
 * itself is served at `/`, because Codex opens only loopback root URLs.
 */
export class LocalPreviewManager {
  readonly #openers: PreviewOpeners;
  readonly #maxPreviews: number;
  readonly #previews = new Map<string, Preview>();

  constructor(openers: PreviewOpeners, options: { maxPreviews?: number } = {}) {
    this.#openers = openers;
    this.#maxPreviews = options.maxPreviews ?? DEFAULT_MAX_PREVIEWS;
  }

  async open(input: { path: string; cwd: string; threadId?: string }): Promise<PreviewOpenResult> {
    if (!this.#openers.page && !this.#openers.browser)
      throw new DelegationControlError(
        "UNSUPPORTED",
        "Preview needs the local Codex Desktop; this Host cannot open pages",
        { path: input.path },
      );
    const file = await this.#resolveFile(input.path, input.cwd);
    const existing = [...this.#previews.values()].find((preview) => preview.file === file);
    if (existing) return this.#present(existing);
    const preview = await this.#serve(file, input.threadId);
    this.#previews.set(preview.previewId, preview);
    await this.#evictBeyondLimit();
    return this.#present(preview);
  }

  list(): { previews: PreviewEntry[] } {
    return { previews: [...this.#previews.values()].map((preview) => this.#entry(preview)) };
  }

  async show(previewId: string): Promise<PreviewOpenResult> {
    return this.#present(this.#get(previewId));
  }

  async close(previewId: string): Promise<{ previewId: string; closed: true }> {
    await this.#close(this.#get(previewId));
    return { previewId, closed: true };
  }

  async closeThread(threadId: string): Promise<void> {
    await Promise.all(
      [...this.#previews.values()]
        .filter((preview) => preview.threadId === threadId)
        .map((preview) => this.#close(preview)),
    );
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#previews.values()].map((preview) => this.#close(preview)));
  }

  async #resolveFile(requested: string, cwd: string): Promise<string> {
    if (!path.isAbsolute(requested) || !path.isAbsolute(cwd))
      throw new DelegationControlError("INVALID_ARGUMENT", "Preview path and cwd must be absolute");
    let file: string;
    let root: string;
    try {
      [file, root] = await Promise.all([realpath(requested), realpath(cwd)]);
    } catch {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        `Preview file does not exist: ${requested}`,
      );
    }
    // Resolved paths, so a symbolic link cannot point the preview outside the workspace.
    if (!within(root, file))
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "Preview file must be inside the Thread's working directory",
      );
    if (!(await stat(file)).isFile())
      throw new DelegationControlError("INVALID_ARGUMENT", "Preview path must be a file");
    return file;
  }

  async #serve(file: string, threadId: string | undefined): Promise<Preview> {
    const root = path.dirname(file);
    const listeners = new Set<ServerResponse>();
    const server = createServer((request, response) => {
      void this.#respond(
        root,
        file,
        listeners,
        request.method ?? "GET",
        request.url ?? "/",
        response,
      ).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const preview: Preview = {
      previewId: randomUUID(),
      path: file,
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      ...(threadId ? { threadId } : {}),
      file,
      root,
      server,
      watcher: undefined,
      listeners,
      page: undefined,
      usedAt: Date.now(),
    };
    preview.watcher = this.#watch(preview);
    return preview;
  }

  #watch(preview: Preview): FSWatcher | undefined {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const watcher = watchDirectory(preview.root, { recursive: true }, () => {
        // Several writes in a burst become one reload.
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          for (const listener of preview.listeners) listener.write("data: reload\n\n");
        }, RELOAD_DEBOUNCE_MS);
      });
      watcher.on("error", () => watcher.close());
      return watcher;
    } catch {
      // Without a watcher the preview still serves; it just does not reload by itself.
      return undefined;
    }
  }

  async #respond(
    root: string,
    file: string,
    listeners: Set<ServerResponse>,
    method: string,
    rawUrl: string,
    response: ServerResponse,
  ): Promise<void> {
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    const pathname = new URL(rawUrl, "http://127.0.0.1").pathname;
    if (pathname === RELOAD_PATH) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      response.write(": preview\n\n");
      listeners.add(response);
      response.on("close", () => listeners.delete(response));
      return;
    }
    const target = await this.#target(root, file, pathname);
    if (!target) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    const type = CONTENT_TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream";
    const headers = { "content-type": type, "cache-control": "no-store" };
    if (type.startsWith("text/html")) {
      const body = injectReload(await readFile(target, "utf8"));
      response.writeHead(200, { ...headers, "content-length": Buffer.byteLength(body) });
      response.end(method === "HEAD" ? undefined : body);
      return;
    }
    response.writeHead(200, headers);
    if (method === "HEAD") response.end();
    else createReadStream(target).pipe(response);
  }

  /** The file a request names, or undefined: no listings, nothing outside the root. */
  async #target(root: string, file: string, pathname: string): Promise<string | undefined> {
    if (pathname === "/") return file;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return undefined;
    }
    if (decoded.includes("\0")) return undefined;
    const candidate = path.resolve(root, `.${decoded}`);
    if (!within(root, candidate)) return undefined;
    try {
      const resolved = await realpath(candidate);
      if (!within(root, resolved)) return undefined;
      return (await stat(resolved)).isFile() ? resolved : undefined;
    } catch {
      return undefined;
    }
  }

  /** Built-in browser first: reuse the tab, reopen it if the user closed it; else the system browser. */
  async #present(preview: Preview): Promise<PreviewOpenResult> {
    preview.usedAt = Date.now();
    let reason = "The built-in browser is unavailable";
    if (this.#openers.page) {
      try {
        if (preview.page) {
          try {
            await preview.page.show();
            return { ...this.#entry(preview), opened: "builtInBrowser" };
          } catch {
            preview.page = undefined;
          }
        }
        preview.page = await this.#openers.page(preview.url);
        await preview.page.show();
        return { ...this.#entry(preview), opened: "builtInBrowser" };
      } catch (error) {
        preview.page = undefined;
        reason = message(error);
      }
    }
    if (!this.#openers.browser)
      throw new DelegationControlError("UNSUPPORTED", `Preview could not be shown: ${reason}`, {
        url: preview.url,
        path: preview.path,
      });
    await this.#openers.browser(new URL(preview.url));
    return { ...this.#entry(preview), opened: "systemBrowser", reason };
  }

  async #evictBeyondLimit(): Promise<void> {
    const byAge = [...this.#previews.values()].sort((left, right) => left.usedAt - right.usedAt);
    for (const preview of byAge.slice(0, Math.max(0, byAge.length - this.#maxPreviews)))
      await this.#close(preview);
  }

  async #close(preview: Preview): Promise<void> {
    this.#previews.delete(preview.previewId);
    preview.watcher?.close();
    for (const listener of preview.listeners) listener.end();
    await preview.page?.close().catch(() => undefined);
    await new Promise<void>((resolve) => {
      preview.server.close(() => resolve());
      preview.server.closeAllConnections();
    });
  }

  #get(previewId: string): Preview {
    const preview = this.#previews.get(previewId);
    if (!preview)
      throw new DelegationControlError("INVALID_ARGUMENT", `Preview '${previewId}' is not open`);
    return preview;
  }

  #entry(preview: Preview): PreviewEntry {
    return {
      previewId: preview.previewId,
      path: preview.path,
      url: preview.url,
      ...(preview.threadId ? { threadId: preview.threadId } : {}),
    };
  }
}
