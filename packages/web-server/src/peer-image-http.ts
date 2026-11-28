import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseContentLength } from "./http-content-length.ts";
import { RpcError } from "./transport.ts";
import { inspectImageHeader, WEB_IMAGE_LIMITS } from "./web-images.ts";

export const PEER_IMAGE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
} as const;

export function peerImageCacheHeaders(etag?: string) {
  return {
    ...PEER_IMAGE_SECURITY_HEADERS,
    "Cache-Control": "private, max-age=300, must-revalidate",
    Vary: "Authorization, Cookie",
    ...(etag === undefined ? {} : { ETag: etag }),
  };
}

export function peerImageETag(value: string | null): string | undefined {
  // Relay opaque validators, not paths or free-form metadata supplied by a Peer.
  return value && /^(?:W\/)?"[a-z0-9._:-]{1,128}"$/iu.test(value) ? value : undefined;
}

export function matchesImageETag(condition: string | undefined, etag: string): boolean {
  const tag = etag.replace(/^W\//u, "");
  return (
    condition?.trim() === "*" ||
    condition?.split(",").some((value) => value.trim().replace(/^W\//u, "") === tag) === true
  );
}

function imageTooLarge(): RpcError {
  return new RpcError("session/attachment-invalid", "Image exceeds 50 MiB.", {
    reason: "IMAGE_TOO_LARGE",
  });
}

export function peerImageLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (Number(value) > WEB_IMAGE_LIMITS.maxImageBytes) throw imageTooLarge();
  return parseContentLength(value);
}

async function* readImageChunks(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return;
  let size = 0;
  try {
    peerImageLength(response);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.byteLength;
      if (size > WEB_IMAGE_LIMITS.maxImageBytes) throw imageTooLarge();
      yield Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function readPeerImageBytes(response: Response): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of readImageChunks(response)) parts.push(chunk);
  return Buffer.concat(parts);
}

const IMAGE_PREFIX_BYTES = 64 * 1024;

export async function servePeerImageBody(
  upstream: Response,
  response: ServerResponse,
  etag: string | undefined,
  length: number | undefined,
): Promise<void> {
  // Keep the bounded full read for older/chunked Peers, encoded bodies and formats with long headers.
  const encoding = upstream.headers.get("content-encoding")?.toLowerCase();
  const canStream =
    length !== undefined && length > IMAGE_PREFIX_BYTES && (!encoding || encoding === "identity");
  const chunks = readImageChunks(upstream);
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await chunks.next();
      if (next.done) break;
      parts.push(next.value);
      size += next.value.length;
      if (!canStream || size < IMAGE_PREFIX_BYTES || size >= length) continue;

      let mediaType: string;
      try {
        ({ mediaType } = inspectImageHeader(Buffer.concat(parts, size)));
      } catch (error) {
        if (
          error instanceof RpcError &&
          "reason" in error.details &&
          error.details.reason === "INVALID_IMAGE"
        )
          break;
        throw error;
      }
      if (response.destroyed) return;
      response.writeHead(200, {
        ...peerImageCacheHeaders(etag),
        "Content-Type": mediaType,
        "Content-Length": String(length),
      });
      async function* body() {
        yield* parts;
        yield* chunks;
      }
      await pipeline(Readable.from(body(), { objectMode: false }), response);
      return;
    }
    for await (const chunk of chunks) parts.push(chunk);
    const bytes = Buffer.concat(parts);
    const { mediaType } = inspectImageHeader(bytes);
    if (response.destroyed) return;
    response.writeHead(200, {
      ...peerImageCacheHeaders(etag),
      "Content-Type": mediaType,
      "Content-Length": String(bytes.length),
    });
    response.end(bytes);
  } finally {
    await chunks.return(undefined);
  }
}
