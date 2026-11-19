import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

export const COMPRESSION_THRESHOLD = 1024;

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const compressedAssets = new Map<string, Promise<Buffer>>();

function isCompressible(contentType: string): boolean {
  const type = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    type.startsWith("text/") ||
    [
      "application/json",
      "application/javascript",
      "image/svg+xml",
      "application/manifest+json",
    ].includes(type)
  );
}

function negotiate(acceptEncoding: string | undefined): "br" | "gzip" | undefined {
  const encodings = (acceptEncoding ?? "").split(",").flatMap((entry) => {
    const [encoding, ...parameters] = entry.toLowerCase().split(";");
    return parameters.some((parameter) => /^q\s*=\s*0(?:\.0*)?$/u.test(parameter.trim()))
      ? []
      : [encoding?.trim()];
  });
  return encodings.includes("br") ? "br" : encodings.includes("gzip") ? "gzip" : undefined;
}

/** URL-keyed caching is only for immutable assets; RPC and unversioned bodies are compressed anew. */
export async function compressResponse(
  body: Buffer,
  contentType: string,
  acceptEncoding: string | undefined,
  cacheUrl?: string,
): Promise<{ body: Buffer; headers: Record<string, string> }> {
  const headers: Record<string, string> = {};
  if (!isCompressible(contentType)) return { body, headers };
  headers.vary = "Accept-Encoding";
  const encoding = negotiate(acceptEncoding);
  if (encoding === undefined || body.length < COMPRESSION_THRESHOLD) return { body, headers };

  const key = cacheUrl === undefined ? undefined : `${encoding}:${cacheUrl}`;
  let compressed = key === undefined ? undefined : compressedAssets.get(key);
  if (compressed === undefined) {
    compressed =
      encoding === "br"
        ? brotliAsync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })
        : gzipAsync(body, { level: 6 });
    if (key !== undefined) {
      // Cache the pending result too, so concurrent requests share one compression.
      compressedAssets.set(key, compressed);
      if (compressedAssets.size > 64) compressedAssets.clear();
    }
  }
  headers["content-encoding"] = encoding;
  return { body: await compressed, headers };
}
