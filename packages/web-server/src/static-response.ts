import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { compressResponse } from "./compression.ts";
import type { AssetResponse } from "./web-assets.ts";

export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

export async function sendAsset(
  request: IncomingMessage,
  response: ServerResponse,
  asset: AssetResponse | undefined,
  cacheControl = "no-cache",
  revalidate = false,
): Promise<void> {
  if (asset === undefined) {
    response.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  const headers: Record<string, string> = { "cache-control": cacheControl };
  let cacheKey = cacheControl === IMMUTABLE_CACHE ? request.url : undefined;
  if (revalidate) {
    const hash = createHash("sha256").update(asset.body).digest("hex");
    const tag = `"${hash}"`;
    // The same validator covers different content encodings of these bytes.
    headers.etag = `W/${tag}`;
    headers.vary = "Accept-Encoding";
    const condition = request.headers["if-none-match"];
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      (condition?.trim() === "*" ||
        condition?.split(",").some((value) => value.trim().replace(/^W\//u, "") === tag))
    ) {
      response.writeHead(304, headers).end();
      return;
    }
    cacheKey = `sha256:${hash}`;
  }
  const compressed = await compressResponse(
    asset.body,
    asset.contentType,
    request.headers["accept-encoding"],
    cacheKey,
  );
  response
    .writeHead(200, {
      "content-type": asset.contentType,
      ...headers,
      ...compressed.headers,
    })
    .end(compressed.body);
}
