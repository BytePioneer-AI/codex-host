/** Authenticated, seekable video delivery for local workspace previews. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

const VIDEO_TYPES: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
};

/** Undefined means ignore the Range header; null means a valid but unsatisfiable range. */
function videoRange(header: string, size: number): readonly [number, number] | null | undefined {
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!match[1]) {
    const length = Number(match[2]);
    return length === 0 || size === 0 ? null : [Math.max(0, size - length), size - 1];
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (match[2] && end < start) return undefined;
  if (start >= size) return null;
  return [start, Math.min(end, size - 1)];
}

/** Stream an allowed video type without buffering the complete file or changing download behavior. */
export async function serveWorkspaceVideo(
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
  const mediaType = VIDEO_TYPES[extname(path).toLowerCase()];
  let file;
  try {
    // Use the same Session scope and absolute-path semantics as file previews and downloads.
    file = await open(resolve(root, path), constants.O_RDONLY | constants.O_NONBLOCK);
    const meta = await file.stat();
    if (!meta.isFile()) throw new Error("not a regular file");
    if (mediaType === undefined) {
      response.writeHead(415).end();
      return;
    }
    response.setHeader("Content-Type", mediaType);
    response.setHeader("Content-Disposition", "inline");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Accept-Ranges", "bytes");
    // Without a validator, a conditional range must receive the full representation.
    const range =
      request.method === "GET" && request.headers.range && !request.headers["if-range"]
        ? videoRange(request.headers.range, meta.size)
        : undefined;
    if (range === null) {
      response
        .writeHead(416, { "Content-Range": `bytes */${meta.size}`, "Content-Length": "0" })
        .end();
      return;
    }
    const [start, end] = range ?? [0, meta.size - 1];
    if (range !== undefined)
      response.setHeader("Content-Range", `bytes ${start}-${end}/${meta.size}`);
    response.writeHead(range === undefined ? 200 : 206, {
      "Content-Length": String(end - start + 1),
    });
    if (request.method === "HEAD" || meta.size === 0) response.end();
    else await pipeline(file.createReadStream({ autoClose: false, start, end }), response);
  } catch {
    if (!response.headersSent) response.writeHead(404).end();
    else response.destroy();
  } finally {
    await file?.close();
  }
}
