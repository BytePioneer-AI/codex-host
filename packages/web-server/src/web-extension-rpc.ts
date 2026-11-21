import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { get } from "node:https";
import { BlockList, type LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESKTOP_EXTENSION_ZIP_MAX_BYTES as ZIP_LIMIT,
  WEB_EXTENSION_ASSETS_PREFIX,
  WEB_EXTENSION_CATALOG_URL,
  WEB_EXTENSION_RPC_ERRORS as errors,
  WEB_EXTENSION_UPLOAD_PATH,
  WEB_EXTENSIONS_RPC as methods,
  parseExtensionCatalogV2,
  webExtensionsRpcSchemas,
  type WebExtensionList,
  type WebExtensionsRpcMethod,
  type WebExtensionsRpcParams,
  type WebExtensionsRpcResult,
  type WebNativeExtensionSource,
} from "@codexhost/shared-contracts";
import type { RequestAuth } from "./auth.ts";
import type { RequestTrust } from "./request-trust.ts";
import { RpcError, type RpcRegistry } from "./transport.ts";
import type { WebUiExtensions } from "./ui-extensions.ts";
import type { WebNativeExtensions } from "./web-native-extensions.ts";

const CATALOG_MIRROR =
  "https://cdn.jsdelivr.net/gh/BytePioneer-AI/codexhost-extensions-registry@main/catalog.v2.json";
const CACHE_TTL = 5 * 60_000;
const UPLOAD_TTL = 2 * 60_000;
const UPLOAD_SLOTS = 4;
const JSON_LIMIT = 2 * 1024 * 1024;
const RELEASE_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
const CATALOG_HOSTS = new Set(["raw.githubusercontent.com", "cdn.jsdelivr.net"]);
const MARKET_HOSTS = new Set([...RELEASE_HOSTS, ...CATALOG_HOSTS]);

const reservedV4 = new BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  reservedV4.addSubnet(address, bits);
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const reservedV6 = new BlockList();
for (const [address, bits] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  reservedV6.addSubnet(address, bits, "ipv6");

// Validate the addresses actually passed to the socket, not a preflight DNS query.
const publicLookup: LookupFunction = (hostname, options, callback) => {
  void lookup(hostname, { ...options, all: true }).then(
    (addresses) => {
      const publicAddresses = addresses.filter(({ address, family }) =>
        family === 4
          ? !reservedV4.check(address)
          : family === 6 && globalV6.check(address, "ipv6") && !reservedV6.check(address, "ipv6"),
      );
      const first = publicAddresses[0];
      if (!first) callback(new Error("No public download address"), "", 0);
      else if (options.all) callback(null, publicAddresses);
      else callback(null, first.address, first.family);
    },
    (error: NodeJS.ErrnoException) => callback(error, "", 0),
  );
};

async function download(
  input: string,
  hosts: ReadonlySet<string>,
  limit: number,
  accept: string,
  shutdown: AbortSignal,
): Promise<Buffer> {
  const signal = AbortSignal.any([shutdown, AbortSignal.timeout(12_000)]);
  let url = new URL(input);
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      !hosts.has(url.hostname)
    )
      throw new Error("Unapproved extension download origin");
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      get(
        url,
        {
          signal,
          agent: false,
          lookup: publicLookup,
          headers: { accept, "user-agent": "codexhost-web-extensions" },
        },
        resolve,
      ).once("error", reject);
    });
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
      response.destroy();
      url = new URL(response.headers.location, url);
      continue;
    }
    if (status !== 200 || Number(response.headers["content-length"]) > limit) {
      response.destroy();
      throw new Error("Extension download failed or exceeds the size limit");
    }
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new Error("Extension download exceeds the size limit");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks, size);
  }
  throw new Error("Too many extension download redirects");
}

type Market = WebExtensionsRpcResult<typeof methods.marketRefresh>;
class ExtensionSources {
  #cache?: { at: number; market: Market };
  #pending: Promise<Market> | undefined;

  constructor(
    private readonly signal: AbortSignal,
    private readonly fetchBytes: typeof download,
  ) {}

  async market(refresh = false): Promise<Market> {
    if (this.#pending) return this.#pending;
    if (!refresh && this.#cache && Date.now() - this.#cache.at < CACHE_TTL)
      return this.#cache.market;
    this.#pending = this.#refresh();
    try {
      return await this.#pending;
    } finally {
      this.#pending = undefined;
    }
  }

  async #refresh(): Promise<Market> {
    try {
      const candidate = async (url: string, signal: AbortSignal) =>
        parseExtensionCatalogV2(
          JSON.parse(
            (
              await this.fetchBytes(url, CATALOG_HOSTS, JSON_LIMIT, "application/json", signal)
            ).toString("utf8"),
          ),
        );
      const race = new AbortController();
      const raceSignal = AbortSignal.any([this.signal, race.signal]);
      const parsed = await Promise.any(
        [WEB_EXTENSION_CATALOG_URL, CATALOG_MIRROR].map((url) => candidate(url, raceSignal)),
      ).finally(() => race.abort());
      const market = {
        generatedAt: parsed.generatedAt,
        extensions: parsed.extensions.filter(({ targets }) => targets.includes("web")),
        skippedCount: parsed.skipped.length,
        stale: false,
      };
      this.#cache = { at: Date.now(), market };
      return market;
    } catch {
      const error = "Web extension market is unavailable.";
      if (!this.#cache) throw new RpcError(errors.marketUnavailable, error);
      const market = { ...this.#cache.market, stale: true, error };
      this.#cache = { at: Date.now(), market };
      return market;
    }
  }

  async zip(source: Exclude<WebNativeExtensionSource, { type: "zip" }>) {
    if (source.type === "market") {
      const { id, version, sha256 } = source;
      const { extensions } = await this.market();
      const entry = extensions.find(
        (row) => row.id === id && row.version === version && row.sha256 === sha256,
      );
      if (!entry)
        throw new RpcError(errors.stale, "Refresh the market and choose a current release.");
      if (entry.apis.web !== 1 || (entry.apis.backend !== undefined && entry.apis.backend !== 1))
        throw new RpcError(errors.invalidParams, "This release requires a newer extension API.");
      const zipBuffer = await this.fetchBytes(
        entry.downloadUrl,
        MARKET_HOSTS,
        ZIP_LIMIT,
        "application/zip",
        this.signal,
      );
      return { zipBuffer, expected: { id, version, sha256 } };
    }
    const { repository, tag, asset } = source;
    if (tag === "." || tag === ".." || (tag && /[\x00-\x20\x7f\\]/u.test(tag)))
      throw new RpcError(errors.invalidParams, "Invalid GitHub release tag.");
    const suffix = tag === undefined ? "latest" : `tags/${encodeURIComponent(tag)}`;
    const metadata: unknown = JSON.parse(
      (
        await this.fetchBytes(
          `https://api.github.com/repos/${repository}/releases/${suffix}`,
          new Set(["api.github.com"]),
          JSON_LIMIT,
          "application/vnd.github+json",
          this.signal,
        )
      ).toString("utf8"),
    );
    const assets =
      metadata && typeof metadata === "object" && "assets" in metadata && metadata.assets;
    const found: unknown = Array.isArray(assets)
      ? assets.find(
          (row: unknown) => row && typeof row === "object" && "name" in row && row.name === asset,
        )
      : undefined;
    if (
      !found ||
      typeof found !== "object" ||
      !("browser_download_url" in found) ||
      typeof found.browser_download_url !== "string"
    )
      throw new RpcError(errors.notFound, "The requested GitHub release ZIP asset was not found.");
    const url = new URL(found.browser_download_url);
    if (
      url.origin !== "https://github.com" ||
      !/^\/[^/]+\/[^/]+\/releases\/download\//u.test(url.pathname) ||
      decodeURIComponent(url.pathname.split("/").at(-1) ?? "") !== asset
    )
      throw new Error("Invalid GitHub release asset URL");
    return {
      zipBuffer: await this.fetchBytes(
        url.href,
        RELEASE_HOSTS,
        ZIP_LIMIT,
        "application/zip",
        this.signal,
      ),
    };
  }
}

class UploadRejected extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Upload = { credential: string; directory: string; expires: NodeJS.Timeout };
class Uploads {
  readonly #ready = new Map<string, Upload>();
  readonly #pending = new Set<Promise<unknown>>();
  #slots = 0;

  constructor(private readonly signal: AbortSignal) {}

  async close() {
    await Promise.allSettled([
      ...[...this.#ready.keys()].map((id) => this.#discard(id)),
      ...this.#pending,
    ]);
  }

  receive(request: IncomingMessage, credential: string): Promise<string> {
    if (this.#slots >= UPLOAD_SLOTS) throw new UploadRejected(429, "Too many pending ZIP uploads.");
    this.#slots++;
    const result = this.#receive(request, credential);
    this.#pending.add(result);
    return result.finally(() => this.#pending.delete(result));
  }

  async #receive(request: IncomingMessage, credential: string): Promise<string> {
    let directory: string | undefined;
    let retained = false;
    const cancel = AbortSignal.any([this.signal, AbortSignal.timeout(UPLOAD_TTL)]);
    const abort = () => request.destroy();
    cancel.addEventListener("abort", abort, { once: true });
    try {
      cancel.throwIfAborted();
      directory = await mkdtemp(join(tmpdir(), "codexhost-web-extension-"));
      const file = await open(join(directory, "upload.zip"), "wx", 0o600);
      try {
        let size = 0;
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          const bytes = chunk as Buffer;
          size += bytes.length;
          if (size > ZIP_LIMIT) throw new UploadRejected(413, "ZIP exceeds 64 MiB.");
          await file.writeFile(bytes);
        }
        if (!request.complete || size === 0) throw new UploadRejected(400, "Expected a ZIP body.");
      } finally {
        await file.close();
      }
      cancel.throwIfAborted();
      const id = randomUUID();
      const expires = setTimeout(() => void this.#discard(id), UPLOAD_TTL).unref();
      this.#ready.set(id, { credential, directory, expires });
      retained = true;
      return id;
    } finally {
      cancel.removeEventListener("abort", abort);
      if (!retained) await this.#remove(directory);
    }
  }

  consume(id: string, credential: string): Promise<Buffer> {
    const upload = this.#ready.get(id);
    if (!upload || upload.credential !== credential)
      throw new RpcError(errors.notFound, "ZIP upload is missing or expired.");
    this.#ready.delete(id);
    clearTimeout(upload.expires);
    const task = readFile(join(upload.directory, "upload.zip"), { signal: this.signal }).finally(
      () => this.#remove(upload.directory),
    );
    this.#pending.add(task);
    return task.finally(() => this.#pending.delete(task));
  }

  async #discard(id: string) {
    const upload = this.#ready.get(id);
    if (!upload) return;
    this.#ready.delete(id);
    clearTimeout(upload.expires);
    await this.#remove(upload.directory);
  }

  async #remove(directory?: string) {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    this.#slots--;
  }
}

/** New mixed management RPCs and their dedicated binary HTTP endpoints. Legacy DSH RPCs stay registered separately. */
export function registerWebExtensionRpc(
  rpc: RpcRegistry,
  native: WebNativeExtensions,
  dsh: WebUiExtensions,
  trust: RequestTrust,
  fetchBytes = download,
) {
  const uploads = new Uploads(native.signal);
  const sources = new ExtensionSources(native.signal, fetchBytes);
  const list = async (): Promise<WebExtensionList> => {
    const state = dsh.state();
    return {
      safeMode: state.safeMode,
      extensions: [
        ...state.extensions.map((row) =>
          row.loadError ? { ...row, loadError: "DSH extension failed to load." } : row,
        ),
        ...(await native.list()),
      ],
      dshLoadedIds: state.loadedIds,
      ...(state.storeError ? { storeError: "The DSH extension registry is invalid." } : {}),
    };
  };
  function register<M extends WebExtensionsRpcMethod>(
    method: M,
    handle: (
      args: WebExtensionsRpcParams<M>,
      auth: RequestAuth,
    ) => WebExtensionsRpcResult<M> | Promise<WebExtensionsRpcResult<M>>,
  ) {
    rpc.register(method, async (args, context) => {
      if (!native.available || context.auth === undefined) {
        if (method === methods.snapshot) return native.snapshot(false);
        throw new RpcError(
          errors.authDisabled,
          "Web extension management is unavailable without authentication or in safe mode.",
        );
      }
      try {
        const parsed = webExtensionsRpcSchemas[method].params.safeParse(args);
        if (!parsed.success)
          throw new RpcError(errors.invalidParams, "Invalid Web extension parameters.");
        return await handle(parsed.data as WebExtensionsRpcParams<M>, context.auth);
      } catch (error) {
        if (error instanceof RpcError) throw error;
        throw new RpcError(errors.changeFailed, "Web extension operation failed.");
      }
    });
  }
  const sourceFor =
    (source: WebNativeExtensionSource, { credential }: RequestAuth) =>
    async () =>
      source.type === "zip"
        ? { zipBuffer: await uploads.consume(source.uploadId, credential) }
        : sources.zip(source);
  register(methods.list, list);
  register(methods.snapshot, () => native.snapshot(true));
  register(methods.install, async ({ format, source }, auth) => {
    if (format === "dsh") await dsh.install(source.spec, source.registry);
    else await native.changePackage(sourceFor(source, auth));
    return list();
  });
  register(methods.update, async ({ id, expectedDigest, source }, auth) => {
    await native.changePackage(sourceFor(source, auth), { id, expectedDigest });
    return list();
  });
  register(methods.setEnabled, async ({ format, id, enabled }) => {
    if (format === "dsh") await dsh.setEnabled(id, enabled);
    else await native.setEnabled(id, enabled);
    return list();
  });
  register(methods.uninstall, async ({ format, id }) => {
    if (format === "dsh") await dsh.remove(id);
    else await native.uninstall(id);
    return list();
  });
  register(methods.settingsGet, ({ id, activationId }) => native.readSettings(id, activationId));
  register(methods.settingsSet, ({ id, activationId, values }) =>
    native.writeSettings(id, activationId, values),
  );
  register(methods.backendInvoke, ({ id, activationId, method, params }) =>
    native.invoke(id, activationId, method, params),
  );
  register(methods.marketRefresh, () => sources.market(true));

  return {
    close: () => uploads.close(),
    async serve(
      request: IncomingMessage,
      response: ServerResponse,
      path: string,
      auth?: RequestAuth,
    ) {
      const upload = path === WEB_EXTENSION_UPLOAD_PATH;
      if (!upload && !path.startsWith(WEB_EXTENSION_ASSETS_PREFIX)) return false;
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (!upload) response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      if (!native.available || auth === undefined || !trust.sameOrigin(request)) {
        response.writeHead(403).end();
      } else if (upload) {
        try {
          if (request.method !== "POST") throw new UploadRejected(405, "Expected POST.");
          if (
            request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !==
            "application/zip"
          )
            throw new UploadRejected(415, "Expected application/zip.");
          if (Number(request.headers["content-length"]) > ZIP_LIMIT)
            throw new UploadRejected(413, "ZIP exceeds 64 MiB.");
          const uploadId = await uploads.receive(request, auth.credential);
          response
            .writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify({ uploadId }));
        } catch (error) {
          if (!response.destroyed) {
            response
              .writeHead(error instanceof UploadRejected ? error.status : 400, {
                "Content-Type": "text/plain",
                connection: "close",
              })
              .end(error instanceof UploadRejected ? error.message : "ZIP upload failed.");
          }
        }
      } else if (request.method === "GET" || request.method === "HEAD") {
        const asset = await native.asset(path);
        if (!asset) response.writeHead(404).end();
        else
          response
            .writeHead(200, {
              "Content-Type": asset.mimeType,
              "Content-Length": asset.bytes.length,
            })
            .end(request.method === "HEAD" ? undefined : asset.bytes);
      } else response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return true;
    },
  };
}
