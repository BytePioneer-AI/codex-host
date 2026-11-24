/** Authenticated original-file downloads and local desktop handoff. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, isAbsolute, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { RpcError } from "./transport.ts";

const DOWNLOAD_TICKET_TTL_MS = 60_000;
const MAX_DOWNLOAD_TICKETS = 256;

export interface WorkspaceDownloadGrant {
  readonly sessionId: string;
  readonly path: string;
}

interface StoredDownloadTicket extends WorkspaceDownloadGrant {
  readonly owner: string | undefined;
  readonly expiresAt: number;
}

/**
 * Short-lived, file-scoped download tickets for browsers (such as iOS standalone PWA modal sheets)
 * that open file downloads in an isolated view without sharing the app's session cookies.
 */
export class WorkspaceDownloadTickets {
  private readonly tickets = new Map<string, StoredDownloadTicket>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(input: { sessionId: string; path: string; owner?: string }): string {
    const current = this.now();
    this.prune(current);
    while (this.tickets.size >= MAX_DOWNLOAD_TICKETS) {
      const oldest = this.tickets.keys().next().value;
      if (oldest === undefined) break;
      this.tickets.delete(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    this.tickets.set(token, {
      sessionId: input.sessionId,
      path: input.path,
      owner: input.owner,
      expiresAt: current + DOWNLOAD_TICKET_TTL_MS,
    });
    return token;
  }

  resolve(token: string): WorkspaceDownloadGrant | undefined {
    const entry = this.tickets.get(token);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.tickets.delete(token);
      return undefined;
    }
    return { sessionId: entry.sessionId, path: entry.path };
  }

  revokeOwner(owner: string): void {
    for (const [token, entry] of this.tickets) {
      if (entry.owner === owner) this.tickets.delete(token);
    }
  }

  private prune(current: number): void {
    for (const [token, entry] of this.tickets) {
      if (entry.expiresAt <= current) this.tickets.delete(token);
    }
  }
}

export async function openWorkspaceFile(
  launcher: string,
  path: unknown,
  action?: "reveal",
): Promise<{ opened: true }> {
  if (!launcher || !isAbsolute(launcher))
    throw new RpcError("session/open-unavailable", "The native launcher is unavailable.");
  if (typeof path !== "string" || path.includes("\0"))
    throw new RpcError("gateway/bad-request", "An absolute path is required.");
  // Markdown links can spell Windows drive paths with a leading slash.
  const nativePath = process.platform === "win32" ? path.replace(/^\/(?=[a-z]:[/\\])/iu, "") : path;
  if (!isAbsolute(nativePath))
    throw new RpcError("gateway/bad-request", "An absolute path is required.");
  const target = await realpath(nativePath);
  if (action === "reveal") {
    const info = await stat(target);
    if (!info.isFile() && !info.isDirectory())
      throw new RpcError(
        "gateway/bad-request",
        "Only regular files and directories can be revealed.",
      );
  } else {
    const file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile())
        throw new RpcError("gateway/bad-request", "Only regular files can be opened.");
    } finally {
      await file.close();
    }
  }
  const command = action === "reveal" ? "reveal-file" : "open-file";
  // DETACHED_PROCESS skips the console without passing SW_HIDE to Explorer.
  const detached = process.platform === "win32" && action === "reveal";
  const child = spawn(launcher, [command, target], {
    stdio: "ignore",
    detached,
    windowsHide: !detached,
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const opened = await new Promise<boolean>((resolve) => {
    let timedOut = false;
    child.on("error", () => resolve(false));
    child.once("close", (code) => resolve(!timedOut && code === 0));
    timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        resolve(false);
      }
    }, 10_000);
  }).finally(() => clearTimeout(timeout));
  if (!opened)
    throw new RpcError(
      "session/open-failed",
      action === "reveal"
        ? "The system could not open the containing folder."
        : "The system could not open this file.",
    );
  return { opened: true };
}

export interface RemoteWorkspaceDownloadDelegate {
  issueDownloadTicket(
    response: ServerResponse,
    sessionId: string,
    path: string,
    tickets: WorkspaceDownloadTickets,
    owner?: string,
    request?: IncomingMessage,
  ): Promise<boolean>;
  downloadFile(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    grant?: WorkspaceDownloadGrant,
  ): Promise<boolean>;
}

/** Issue a short-lived ticket scoped to one verified workspace file. */
export async function issueWorkspaceDownloadTicket(
  response: ServerResponse,
  body: string,
  workspace: (sessionId: string) => string | undefined,
  tickets: WorkspaceDownloadTickets,
  owner?: string,
  remote?: RemoteWorkspaceDownloadDelegate,
  request?: IncomingMessage,
): Promise<void> {
  response.setHeader("Cache-Control", "private, no-store");
  let sessionId = "";
  let path = "";
  try {
    const parsed = JSON.parse(body) as { sessionId?: unknown; path?: unknown };
    if (typeof parsed.sessionId === "string") sessionId = parsed.sessionId;
    if (typeof parsed.path === "string") path = parsed.path;
  } catch {
    response.writeHead(400, { "content-type": "text/plain" }).end("invalid json");
    return;
  }
  if (
    remote &&
    (await remote.issueDownloadTicket(response, sessionId, path, tickets, owner, request))
  ) {
    return;
  }
  const root = workspace(sessionId);
  if (!root || !path || path.includes("\0")) {
    response.writeHead(404).end();
    return;
  }
  let file;
  try {
    file = await open(resolve(root, path), constants.O_RDONLY | constants.O_NONBLOCK);
    const meta = await file.stat();
    if (!meta.isFile()) throw new Error("not a regular file");
    const ticket = tickets.issue({
      sessionId,
      path,
      ...(owner !== undefined ? { owner } : {}),
    });
    response
      .writeHead(200, { "content-type": "application/json; charset=utf-8" })
      .end(JSON.stringify({ ticket, name: basename(path), size: meta.size }));
  } catch {
    if (!response.headersSent) response.writeHead(404).end();
    else response.destroy();
  } finally {
    await file?.close();
  }
}

/** Download bytes without preview conversion or application-level size limits. */
export async function downloadWorkspaceFile(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  workspace: (sessionId: string) => string | undefined,
  grant?: WorkspaceDownloadGrant,
  remote?: RemoteWorkspaceDownloadDelegate,
): Promise<void> {
  response.setHeader("Cache-Control", "private, no-store");
  if (remote && (await remote.downloadFile(request, response, url, grant))) {
    return;
  }
  const sessionId = grant ? grant.sessionId : (url.searchParams.get("sessionId") ?? "");
  const path = grant ? grant.path : url.searchParams.get("path");
  const root = workspace(sessionId);
  if (!root || !path || path.includes("\0")) {
    response.writeHead(404).end();
    return;
  }
  let file;
  try {
    // Match workspace preview: absolute paths may name files outside the cwd.
    file = await open(resolve(root, path), constants.O_RDONLY | constants.O_NONBLOCK);
    const meta = await file.stat();
    if (!meta.isFile()) throw new Error("not a regular file");
    const name = basename(path);
    const encoded = encodeURIComponent(name).replace(
      /[!'()*]/gu,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encoded}`,
      "Content-Length": String(meta.size),
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD" || meta.size === 0) response.end();
    else
      await pipeline(
        file.createReadStream({ autoClose: false, end: Math.max(0, meta.size - 1) }),
        response,
      );
  } catch {
    if (!response.headersSent) response.writeHead(404).end();
    else response.destroy();
  } finally {
    await file?.close();
  }
}
