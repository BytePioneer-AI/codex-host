/** Authenticated original-file downloads and local desktop handoff. */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, isAbsolute, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { RpcError } from "./transport.ts";

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
