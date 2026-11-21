import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HOST_EXTENSION_ASSETS_PREFIX,
  HOST_EXTENSION_UPLOAD_PATH,
  HOST_EXTENSION_ZIP_MAX_BYTES,
  HOST_EXTENSIONS_RPC,
  hostExtensionActivationIdSchema,
  hostExtensionDigestSchema,
  hostExtensionIdSchema,
  hostExtensionResourcePathSchema,
  hostExtensionsAssetResultSchema,
  hostExtensionsRpcSchemas,
  type HostExtensionsRpcParams,
} from "@codexhost/shared-contracts";
import type { RequestAuth } from "./auth.ts";
import type { ChHostClient } from "./ch-host-client.ts";
import type { RequestTrust } from "./request-trust.ts";

const updateParams = hostExtensionsRpcSchemas[HOST_EXTENSIONS_RPC.update].params.omit({
  source: true,
});

type HostChannel = Pick<NonNullable<ChHostClient["realtime"]>, "request">;

export function isHostExtensionHttpPath(pathname: string): boolean {
  return (
    pathname === HOST_EXTENSION_UPLOAD_PATH || pathname.startsWith(HOST_EXTENSION_ASSETS_PREFIX)
  );
}

function parseAssetPath(pathname: string) {
  // Do not use URL.pathname: it normalizes dot segments before we can reject them.
  const [id, activationId, digest, ...parts] = pathname
    .slice(HOST_EXTENSION_ASSETS_PREFIX.length)
    .split("/");
  const segments = parts.map(decodeURIComponent);
  if (
    segments.some(
      (part) => !part || part === "." || part === ".." || /[/\\]|%(?:25)*(?:2e|2f|5c)/iu.test(part),
    )
  )
    throw new Error("Invalid asset path segment");
  return {
    id: hostExtensionIdSchema.parse(id),
    activationId: hostExtensionActivationIdSchema.parse(activationId),
    digest: hostExtensionDigestSchema.parse(digest),
    path: hostExtensionResourcePathSchema.parse(segments.join("/")),
  };
}

async function serveAsset(
  channel: HostChannel,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
) {
  let params: ReturnType<typeof parseAssetPath>;
  try {
    params = parseAssetPath(pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  let result: unknown;
  try {
    result = await channel.request(HOST_EXTENSIONS_RPC.asset, params);
  } catch {
    // Missing, stale and non-public assets are indistinguishable at this boundary.
    response.writeHead(404).end();
    return;
  }
  const asset = hostExtensionsAssetResultSchema.safeParse(result);
  if (!asset.success || !/^[\w.+-]+\/[\w.+-]+$/u.test(asset.data.mimeType)) {
    response.writeHead(502).end();
    return;
  }
  const { mimeType, base64, digest } = asset.data;
  if (digest !== params.digest) {
    response.writeHead(404).end();
    return;
  }
  const bytes = Buffer.from(base64, "base64");
  response
    .writeHead(200, {
      "Content-Type": /^(?:text|application)\/javascript$/iu.test(mimeType)
        ? `${mimeType}; charset=utf-8`
        : mimeType,
      "Content-Length": bytes.length,
      "Cache-Control": "private, max-age=31536000, immutable",
    })
    .end(request.method === "HEAD" ? undefined : bytes);
}

async function readZip(request: IncomingMessage): Promise<string | undefined> {
  if (Number(request.headers["content-length"]) > HOST_EXTENSION_ZIP_MAX_BYTES) return;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > HOST_EXTENSION_ZIP_MAX_BYTES) return;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString("base64");
}

async function serveUpload(
  channel: HostChannel,
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (
    request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/zip"
  ) {
    response.writeHead(415).end();
    return;
  }
  const url = request.url ?? "";
  const queryStart = url.indexOf("?");
  const query = new URLSearchParams(queryStart === -1 ? "" : url.slice(queryStart + 1));
  const ids = query.getAll("id");
  const digests = query.getAll("expectedDigest");
  const activations = query.getAll("expectedActivationId");
  let update:
    Omit<HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.update>, "source"> | undefined;
  if (ids.length || digests.length || activations.length) {
    const parsed = updateParams.safeParse({
      id: ids[0],
      expectedDigest: digests[0],
      ...(activations.length ? { expectedActivationId: activations[0] } : {}),
    });
    if (!parsed.success || ids.length !== 1 || digests.length !== 1 || activations.length > 1) {
      response.writeHead(400).end();
      return;
    }
    update = parsed.data;
  }
  let base64: string | undefined;
  try {
    base64 = await readZip(request);
  } catch {
    if (!response.destroyed) response.writeHead(400, { Connection: "close" }).end();
    return;
  }
  if (base64 === undefined) {
    response.writeHead(413, { Connection: "close" }).end();
    return;
  }
  if (!base64 || !request.complete) {
    response.writeHead(400).end();
    return;
  }
  const source = { type: "zip", base64 };
  let result: unknown;
  try {
    result = update
      ? await channel.request(HOST_EXTENSIONS_RPC.update, { ...update, source })
      : await channel.request(HOST_EXTENSIONS_RPC.install, { source });
  } catch {
    response
      .writeHead(400, { "Content-Type": "application/json" })
      .end(
        JSON.stringify({ error: { message: "Host could not install or update the extension." } }),
      );
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ result }));
}

/** Serve a matched extension route after the Web authentication gate. Only the Host owns assets and ZIP validation. */
export async function serveHostExtensionHttp(
  host: Pick<ChHostClient, "realtime"> | undefined,
  trust: RequestTrust,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  { requestAuth, safeMode = false }: { requestAuth: RequestAuth | undefined; safeMode?: boolean },
): Promise<void> {
  const upload = pathname === HOST_EXTENSION_UPLOAD_PATH;
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (!upload) response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (requestAuth === undefined || safeMode || !trust.sameOrigin(request)) {
    response.writeHead(403).end();
    return;
  }
  if (upload ? request.method !== "POST" : request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: upload ? "POST" : "GET, HEAD" }).end();
    return;
  }
  const channel = host?.realtime;
  if (channel === undefined) {
    response.writeHead(503).end();
    return;
  }
  if (upload) await serveUpload(channel, request, response);
  else await serveAsset(channel, request, response, pathname);
}
