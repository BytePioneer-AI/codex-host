/** Authenticated original-file downloads and local desktop handoff. */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, isAbsolute, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { RpcError } from "./transport.ts";

export async function openWorkspaceFile(
  launcher: string,
  path: unknown,
): Promise<{ opened: true }> {
  if (!launcher || !isAbsolute(launcher))
    throw new RpcError("session/open-unavailable", "The native launcher is unavailable.");
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
    throw new RpcError("gateway/bad-request", "An absolute file path is required.");
  const target = await realpath(path);
  const file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile())
      throw new RpcError("gateway/bad-request", "Only regular files can be opened.");
  } finally {
    await file.close();
  }
  await new Promise<void>((resolve, reject) => {
    execFile(launcher, ["open-file", target], { timeout: 10_000, windowsHide: true }, (error) => {
      if (error)
        reject(new RpcError("session/open-failed", "The system could not open this file."));
      else resolve();
    });
  });
  return { opened: true };
}

/** Download bytes without preview conversion or application-level size limits. */
export async function downloadWorkspaceFile(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  workspace: (sessionId: string) => string | undefined,
): Promise<void> {
  response.setHeader("Cache-Control", "private, no-store");
  const root = workspace(url.searchParams.get("sessionId") ?? "");
  const path = url.searchParams.get("path");
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
