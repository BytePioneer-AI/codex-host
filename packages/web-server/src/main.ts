/**
 * codexhost Web server entry point.
 *
 *   node --import tsx src/main.ts [--port 4400] [--host 127.0.0.1] [--data <dir>]
 *        [--adapters <dir>[,<dir>...]] [--harness <id>[,<id>...]]
 *        [--token <value>] [--trusted-proxy <ip>[,<ip>...]] [--public-url <url>] [--relay <control-host>] [--no-auth]
 *        [--dev-web-ui <apps/web-ui>]
 *
 * `--dev-web-ui` serves the Web UI from that source checkout instead of the packed copy and pushes
 * rebuilt plugin bundles to open pages (used by `npm start web -- --watch`).
 */

import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import qrcode from "qrcode-terminal";
import { createBrowserWebSocketServer } from "./browser-websocket.ts";
import { createWebServer } from "./http-server.ts";
import { compressResponse } from "./compression.ts";

import { registerAccessTokenRpc } from "./access-token-rpc.ts";
import {
  autostartState,
  registerBackgroundControls,
  takeNpmEntrypoint,
} from "./background-controls.ts";
import { registerUiExtensionRpc } from "./ui-extension-rpc.ts";
import { UI_EXTENSION_PAGE } from "./ui-extension-page.ts";
import { WebUiExtensions } from "./ui-extensions.ts";
import { AccessTokenStore } from "./access-tokens.ts";
import { SWITCH_TOKEN_SCRIPT } from "./auth-page.ts";
import { AccessAuth, CredentialConnections, LOCAL_CREDENTIAL, type RequestAuth } from "./auth.ts";
import {
  isLoopbackHost,
  isWildcardHost,
  networkAccessUrls,
  reachableNetworkUrls,
} from "./network-urls.ts";
import { tailscaleServeState, tailscaleState } from "./tailscale-serve.ts";
import type { WebNetworkAccessUrl } from "@codexhost/shared-contracts";
import { RequestTrust } from "./request-trust.ts";
import { RemoteRelay } from "./remote-relay/state.ts";
import { registerRelayRpc } from "./remote-relay/rpc.ts";
import { DESKTOP_SCREENSHOT_PATH } from "@codexhost/shared-contracts/desktop-screenshot";
import { DesktopScreenshots } from "./desktop-screenshot.ts";
import { SIDEBAR_BROWSER_PATH } from "@codexhost/shared-contracts/sidebar-browser";
import { SidebarBrowser } from "./sidebar-browser.ts";
import { registerMisc } from "./misc.ts";
import { PushNotifier } from "./push.ts";
import { ChPushNotifications } from "./ch-push-notifications.ts";
import { CLIENT_GLOBALS, CLIENT_PLUGINS, HMR_CLIENT_PLUGIN } from "./plugins.ts";
import { ChSessions } from "./ch-sessions.ts";
import { WebHarnessDisplaySettings } from "./harness-display-settings.ts";
import { WebHarnessPreferences } from "./harness-preferences.ts";
import { createChHostClient } from "./ch-host-client.ts";
import { RemoteSessions } from "./remote-sessions.ts";
import { serveChClientGateway } from "./ch-client-gateway.ts";
import { DshWebServices, type WebPluginRuntime } from "./dsh-web-services.ts";
import { createOfficeEngine } from "./office-engine.ts";
import { harnessIconStyles } from "./harness-icon-styles.ts";
import { Settings } from "./settings.ts";
import { formatWebStartup } from "./startup-display.ts";
import { DataDir } from "./store.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "./transport.ts";
import type { SessionListTiming } from "./session-list-timing.ts";
import { WebAssets, type AssetResponse, type WebAssetOptions } from "./web-assets.ts";
import { SHELL_EVENTS_PATH, WebShellReload } from "./web-hmr.ts";
import { Workspaces } from "./workspaces.ts";
import { inspectImage, readImageFile, WebImages } from "./web-images.ts";
import { WebFiles } from "./web-files.ts";
import { serveFileUpload } from "./ch-file-upload-http.ts";
import { registerVoiceStatus, serveVoiceTranscription } from "./voice-http.ts";
import { defaultWebDataDirectory } from "./data-paths.ts";
import { snapshotPackagedHost } from "./packaged-host.ts";
import {
  publicAccessUrl,
  readServiceOptions,
  saveServiceOptions,
  SETTINGS_CHANGED_EXIT_CODE,
} from "./background-service.ts";

declare const CODEXHOST_RELEASE_WEB: boolean;
const RELEASE_WEB = typeof CODEXHOST_RELEASE_WEB !== "undefined" && CODEXHOST_RELEASE_WEB;

/** The release entry is in app/web-modules; the standalone packed entry is in app/. */
const DISTRIBUTION_ROOT = resolve(import.meta.dirname, "..");
const PACKED_WEB = join(DISTRIBUTION_ROOT, "web");
const PACKED = existsSync(join(PACKED_WEB, "plugins.json"));
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
// A packed Web distribution ships the subprocess runner as JavaScript beside
// the server bundle; the source package's TypeScript entry is not runnable.
if (PACKED) {
  const runner = join(import.meta.dirname, "subprocess-runner.mjs");
  if (existsSync(runner)) process.env.CODEXHOST_SUBPROCESS_RUNNER ??= runner;
}
function defaultAdapterRoots(): string {
  return PACKED
    ? join(DISTRIBUTION_ROOT, "adapters")
    : resolve(REPO_ROOT, "packages/host-runtime/dist/plugins");
}

const developmentOptions = {
  "ch-cdp": { type: "string" },
  "ch-control-directory": { type: "string" },
  "no-auth": { type: "boolean", default: false },
  "dev-web-ui": { type: "string" },
} as const;
const { values } = parseArgs({
  options: {
    "session-source": { type: "string", default: "codexhost" },
    ...((RELEASE_WEB ? {} : developmentOptions) as typeof developmentOptions),
    "ch-launcher": { type: "string" },
    "ch-host-runtime": { type: "string" },
    "ch-node": { type: "string" },
    "ch-data": { type: "string" },
    "ch-codex-home": { type: "string" },
    "ch-plugins": { type: "string" },
    background: { type: "boolean", default: false },
    "save-service-options": { type: "boolean", default: false },
    "ready-file": { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
    data: {
      type: "string",
      default: process.env.CODEXHOST_WEB_DATA,
    },
    adapters: { type: "string", default: process.env.CODEXHOST_ADAPTERS },
    harness: { type: "string", default: process.env.CODEXHOST_HARNESSES },
    workspace: {
      type: "string",
      default: process.env.CODEXHOST_DEFAULT_WORKSPACE ?? join(homedir(), "codexhost-workspace"),
    },
    token: { type: "string", default: process.env.CODEXHOST_WEB_TOKEN },
    "trusted-proxy": { type: "string" },
    "public-url": { type: "string" },
    relay: { type: "string" },
    "import-recent": { type: "string", default: process.env.CODEXHOST_IMPORT_RECENT },
    "safe-mode": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values["session-source"] !== "codexhost") throw new Error("Unknown --session-source");

const dataRoot = resolve(
  values.data ??
    defaultWebDataDirectory(
      values["ch-data"] ??
        (values["ch-control-directory"]
          ? dirname(resolve(values["ch-control-directory"]))
          : undefined),
    ),
);
const data = new DataDir(dataRoot);
if (values["save-service-options"]) {
  try {
    process.exit(saveServiceOptions(data, values) ? SETTINGS_CHANGED_EXIT_CODE : 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
if (!values.background && values.relay !== undefined)
  saveServiceOptions(data, { relay: values.relay });
const serviceOptions = readServiceOptions(data);
const background = values.background ? serviceOptions : undefined;
if (background) {
  values.host = background.host;
  values.port = String(background.port);
} else {
  values.host ??= process.env.CODEXHOST_WEB_HOST ?? "127.0.0.1";
  values.port ??= process.env.CODEXHOST_WEB_PORT ?? "4400";
}
const publicUrl = background
  ? background.publicUrl
  : (values["public-url"] ?? process.env.CODEXHOST_WEB_PUBLIC_URL);
const trustedProxies = background
  ? background.trustedProxies
  : (values["trusted-proxy"] ?? process.env.CODEXHOST_WEB_TRUSTED_PROXIES);
const publicUrls: WebNetworkAccessUrl[] =
  publicUrl === undefined ? [] : [{ kind: "public", url: publicAccessUrl(publicUrl) }];
const trust = new RequestTrust(trustedProxies);
const accessTokens =
  values["no-auth"] === true
    ? undefined
    : new AccessTokenStore(data, values.token === undefined ? {} : { token: values.token });
const connections = new CredentialConnections();
const auth = accessTokens && new AccessAuth(accessTokens, trust, connections);
const rpc = new RpcRegistry();
const streams = new StreamRegistry();
const events = new EventHub(homedir());
const displayDirectory = resolve(
  values["ch-data"] ??
    (values["ch-control-directory"]
      ? dirname(resolve(values["ch-control-directory"]))
      : join(homedir(), ".codexhost")),
);
const displayEntries = () => displaySettings.entries();
const enabledHarnesses =
  values.harness === undefined || values.harness === "all"
    ? undefined
    : new Set(values.harness.split(","));
const workspaces = new Workspaces(data, resolve(values.workspace as string), true);
const packagedHost =
  PACKED && !values["ch-cdp"] && !values["ch-host-runtime"]
    ? await snapshotPackagedHost(DISTRIBUTION_ROOT, displayDirectory)
    : DISTRIBUTION_ROOT;
const pluginSource = resolve(values["ch-plugins"] ?? values.adapters ?? defaultAdapterRoots());
const launcher = resolve(
  values["ch-launcher"] ??
    (PACKED
      ? join(packagedHost, "native", process.platform === "win32" ? "codexhost.exe" : "codexhost")
      : join(
          REPO_ROOT,
          "target/debug",
          process.platform === "win32" ? "codexhost.exe" : "codexhost",
        )),
);
const npmEntrypoint = takeNpmEntrypoint();
const desktopScreenshots = new DesktopScreenshots([launcher]);
const chHost = await createChHostClient({
  launch: {
    launcher,
    ...(values["ch-node"] ? { node: resolve(values["ch-node"]) } : {}),
    runtime: resolve(
      values["ch-host-runtime"] ??
        (PACKED
          ? join(packagedHost, "app/host-runtime.mjs")
          : join(REPO_ROOT, "packages/host-runtime/dist/main.js")),
    ),
    dataDirectory: resolve(
      values["ch-data"] ??
        (values["ch-control-directory"]
          ? dirname(resolve(values["ch-control-directory"]))
          : join(homedir(), ".codexhost")),
    ),
    bundledPlugins:
      PACKED && pluginSource === resolve(DISTRIBUTION_ROOT, "adapters")
        ? join(packagedHost, "adapters")
        : pluginSource,
    ...(values["ch-codex-home"] ? { codexHome: resolve(values["ch-codex-home"]) } : {}),
    environment: npmEntrypoint,
  },
  ...(values["ch-data"] && !values["ch-control-directory"]
    ? { directory: join(resolve(values["ch-data"]), "client-hosts") }
    : {}),
  ...(values["ch-cdp"] ? { cdp: values["ch-cdp"] } : {}),
  ...(values["ch-control-directory"] ? { directory: values["ch-control-directory"] } : {}),
});
const displaySettings: WebHarnessDisplaySettings = new WebHarnessDisplaySettings(
  chHost,
  displayDirectory,
  events,
);
const preferences: WebHarnessPreferences = new WebHarnessPreferences(chHost, events);
const images = new WebImages(data);
const files = new WebFiles(data);
const sessions = new ChSessions(
  chHost,
  workspaces,
  events,
  images,
  files,
  displayEntries,
  preferences,
  enabledHarnesses,
);
// The right Sidebar's DSH backend runs in this process; a failure disables the
// panel without taking Web down.
const dsh = await DshWebServices.open({
  workspaceRoot: resolve(values.workspace as string),
  threadWorkspace: (id) => sessions.terminalWorkspaceRoot(id),
  fileWorkspace: (id) => sessions.fileWorkspaceRoot(id),
  ...(RELEASE_WEB
    ? {
        ensureOfficeEngine: createOfficeEngine(
          dataRoot,
          JSON.parse(readFileSync(join(import.meta.dirname, "office-engines.json"), "utf8")),
        ),
      }
    : {}),
}).catch((error: unknown) => {
  console.warn(
    "[right-sidebar] unavailable:",
    error instanceof Error ? error.message : String(error),
  );
  return undefined;
});
if (dsh) streams.setFallback((endpoint, args, sink) => dsh.stream(endpoint, args, sink));
const settings = new Settings(data, events);
const push = new PushNotifier(data);
if (accessTokens !== undefined) {
  push.retainOwners((owner) => owner === LOCAL_CREDENTIAL || accessTokens.has(owner));
  accessTokens.onRevoked((id) => {
    connections.revoke(id);
    push.dropOwner(id);
  });
}
const pushNotifications = chHost.realtime
  ? new ChPushNotifications(chHost.realtime, push)
  : undefined;
const devWebUi = values["dev-web-ui"] === undefined ? undefined : resolve(values["dev-web-ui"]);
const assetOptions: WebAssetOptions =
  PACKED && devWebUi === undefined
    ? {
        packedRoot: PACKED_WEB,
        plugins: [],
        globals: CLIENT_GLOBALS,
        title: "CodexHost",
      }
    : {
        repoRoot: devWebUi ?? resolve(REPO_ROOT, "apps/web-ui"),
        plugins: CLIENT_PLUGINS,
        globals: { ...CLIENT_GLOBALS, __CODEXHOST_DEV_WEB_UI__: devWebUi !== undefined },
        title: "CodexHost",
      };
const builtInAssets = new WebAssets(assetOptions);
const recoveryAssets = new WebAssets({
  ...assetOptions,
  plugins: CLIENT_PLUGINS.filter((id) => id !== HMR_CLIENT_PLUGIN),
});
const extensions = new WebUiExtensions(data, {
  safeMode: values["safe-mode"],
  validate: (externalPlugins) => {
    new WebAssets({ ...assetOptions, externalPlugins });
  },
  apply: async (externalPlugins, changedId) => {
    if (pluginRuntime === undefined) throw new Error("The Web plugin runtime is unavailable");
    return pluginRuntime.update(externalPlugins, changedId);
  },
});
await extensions.cleanup();
let assets = values["safe-mode"] ? recoveryAssets : builtInAssets;
let pluginRuntime: WebPluginRuntime | undefined;
let listeningPort = Number(values.port);
if (!values["safe-mode"]) {
  try {
    if (dsh === undefined) throw new Error("The DSH Web backend is unavailable");
    pluginRuntime = await dsh.loadPlugins({
      packages: [],
      builtins: builtInAssets.clientSources(),
      address: () => ({ host: values.host as string, port: listeningPort }),
      reserved: [
        ...["/api", "/plugins", "/assets", "/harness-icons"].map((path) => ({
          kind: "prefix" as const,
          path,
        })),
        ...[
          "/",
          "/index.html",
          "/extensions",
          "/favicon.ico",
          "/favicon.svg",
          "/favicon-dark.svg",
          "/manifest.webmanifest",
          "/apple-touch-icon.png",
          "/icon-192.png",
          "/icon-512.png",
          "/sw.js",
          "/codexhost-settings.js",
          SIDEBAR_BROWSER_PATH,
        ].map((path) => ({ kind: "exact" as const, path })),
      ],
    });
    assets = new WebAssets({ ...assetOptions, clients: pluginRuntime.clients });
    // Validate saved packages before executing their entries, as on explicit enable.
    new WebAssets({ ...assetOptions, externalPlugins: extensions.plugins() });
    await extensions.restore();
  } catch (error) {
    // A saved selection may be invalid while the empty runtime and its transport
    // remain usable for recovery management. Core backend services stay mounted.
    extensions.composed(
      [],
      error instanceof Error ? error.message : "Extension composition failed.",
    );
    console.warn("[extensions] using built-in UI; manage extensions at /extensions");
  }
}
const shellReload = devWebUi === undefined ? undefined : new WebShellReload(assets);

streams.register("$events", events.handler);
workspaces.register(rpc, streams);
sessions.register(rpc, streams);
sessions.registerCommands(rpc);
sessions.registerImport(rpc);
const remoteSessions = new RemoteSessions(events, undefined, workspaces);
remoteSessions.install(rpc, streams);
preferences.register(rpc);
displaySettings.register(rpc);
settings.register(rpc);
push.register(rpc);
async function readNetworkAccess() {
  const host = values.host as string;
  const tailscale = await tailscaleState(listeningPort);
  trust.trustLoopback = tailscale.status === "serving";
  const serve: WebNetworkAccessUrl[] = [];
  if (tailscale.status === "serving") {
    serve.push({
      kind: tailscale.funnel ? "tailscale-funnel" : "tailscale-https",
      url: tailscale.url,
    });
  }
  return {
    tailscale,
    relay: relay.access,
    networkUrls: [
      ...publicUrls,
      ...(relay.state.status === "connected"
        ? [{ kind: "relay" as const, url: relay.state.url }]
        : []),
      ...serve,
      ...networkAccessUrls(host, listeningPort),
    ],
    ...(background ? { directCandidates: networkAccessUrls("0.0.0.0", listeningPort) } : {}),
  };
}
registerAccessTokenRpc(rpc, accessTokens, {
  port: () => listeningPort,
  access: async () => {
    const [access, autostart] = await Promise.all([
      readNetworkAccess(),
      background ? autostartState(launcher) : undefined,
    ]);
    return {
      ...access,
      ...(autostart === undefined
        ? {}
        : {
            background: { lan: isWildcardHost(values.host as string), autostart },
          }),
    };
  },
});
registerBackgroundControls(rpc, accessTokens, {
  background: background !== undefined,
  port: () => listeningPort,
  data,
  launcher,
  npmEntrypoint,
  shutdown,
});
registerMisc(rpc, { events });
registerUiExtensionRpc(rpc, extensions, {
  port: () => (server.address() as { port: number }).port,
});
registerVoiceStatus(rpc, chHost);

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
/** Harness icon URLs are stable; serve the cached copy while revalidating in the background.
 * `--dev-web-ui` keeps them fresh so icon changes show on reload. */
const HARNESS_ICON_CACHE =
  devWebUi === undefined ? "private, max-age=86400, stale-while-revalidate=604800" : "no-cache";

async function send(
  request: IncomingMessage,
  response: ServerResponse,
  asset: AssetResponse | undefined,
  cacheControl = "no-cache",
): Promise<void> {
  if (asset === undefined) {
    response.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  const compressed = await compressResponse(
    asset.body,
    asset.contentType,
    request.headers["accept-encoding"],
    cacheControl === IMMUTABLE_CACHE ? request.url : undefined,
  );
  response
    .writeHead(200, {
      "content-type": asset.contentType,
      "cache-control": cacheControl,
      ...compressed.headers,
    })
    .end(compressed.body);
}

async function readBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<string | undefined> {
  // 32 MiB of image bytes plus base64/JSON overhead. Reject before parsing or saving.
  const limit = 48 * 1024 * 1024;
  const reject = () => {
    response
      .writeHead(413, { "content-type": "text/plain", "cache-control": "no-store" })
      .end("request too large");
    request.resume();
  };
  if (Number(request.headers["content-length"]) > limit) {
    reject();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      reject();
      return;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = createWebServer((request, response) => {
  const url = request.url ?? "/";
  const pathname = url.split("?")[0] ?? "/";
  void (async () => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
    if (trust.relaySockets.has(request.socket))
      response.setHeader("Strict-Transport-Security", "max-age=31536000");
    let requestAuth: RequestAuth | undefined;
    if (auth !== undefined) {
      const admission = await auth.gate(request, response, pathname);
      if (admission.handled) return;
      requestAuth = admission.auth;
    }
    if (pathname === "/api/file" && (request.method === "GET" || request.method === "HEAD")) {
      const path = new URL(url, "http://localhost").searchParams.get("path");
      response.setHeader("Cache-Control", "private, no-store");
      if (!path) {
        response.writeHead(400).end(request.method === "HEAD" ? undefined : "missing path");
        return;
      }
      try {
        const image = inspectImage(readImageFile(path));
        response.writeHead(200, {
          "Content-Type": image.ref.mediaType,
          "Content-Length": image.bytes.length,
        });
        response.end(request.method === "HEAD" ? undefined : image.bytes);
      } catch {
        response.writeHead(404).end(request.method === "HEAD" ? undefined : "image unavailable");
      }
      return;
    }
    if (pathname.startsWith("/api/ch/v1/")) {
      if (!trust.sameOrigin(request)) {
        response
          .writeHead(403, { "content-type": "text/plain" })
          .end("cross-origin request rejected");
        return;
      }
      await serveChClientGateway(chHost, request, response);
      return;
    }
    if (request.method === "POST" && pathname.startsWith("/api/")) {
      if (!trust.sameOrigin(request)) {
        response
          .writeHead(403, { "content-type": "text/plain" })
          .end("cross-origin request rejected");
        return;
      }
      if (pathname === DESKTOP_SCREENSHOT_PATH) {
        await desktopScreenshots.serve(request, response);
        return;
      }
      if (pathname === "/api/voice/transcribe") {
        await serveVoiceTranscription(chHost, dataRoot, request, response);
        return;
      }
      if (pathname === "/api/session/uploadFileBinary") {
        await serveFileUpload(sessions, request, response);
        return;
      }
      const body = await readBody(request, response);
      if (body === undefined) return;
      if (dsh && (await dsh.handleApiRequest(request, body, response))) return;
      let listTiming: SessionListTiming | undefined;
      let listOk = false;
      const reply = await rpc.handleHttp(
        body,
        requestAuth,
        (callback) => {
          response.once("finish", callback);
        },
        trust.relaySockets.has(request.socket),
        (timing, ok) => {
          listTiming = timing;
          listOk = ok;
        },
      );
      const contentType = "application/json; charset=utf-8";
      let encodedBytes: number | undefined;
      let responseReady = false;
      try {
        const compress = () =>
          compressResponse(Buffer.from(reply), contentType, request.headers["accept-encoding"]);
        const compressed = listTiming
          ? await listTiming.measure("compress", compress)
          : await compress();
        encodedBytes = compressed.body.length;
        response
          .writeHead(200, {
            "content-type": contentType,
            "cache-control": "no-store",
            ...compressed.headers,
            ...(listTiming ? { "server-timing": listTiming.serverTiming() } : {}),
          })
          .end(compressed.body);
        responseReady = true;
      } finally {
        listTiming?.report(listOk && responseReady, encodedBytes);
      }
      return;
    }
    if (pathname === "/extensions") {
      await send(request, response, {
        contentType: "text/html; charset=utf-8",
        body: Buffer.from(UI_EXTENSION_PAGE),
      });
      return;
    }
    if (pathname === "/" || pathname === "/index.html") {
      const builtInOnly = new URL(url, "http://localhost").searchParams.get("extensions") === "off";
      const source = (builtInOnly ? recoveryAssets : assets).index();
      const index =
        !builtInOnly && pluginRuntime !== undefined
          ? { ...source, body: Buffer.from(pluginRuntime.renderIndex(source.body.toString())) }
          : source;
      await send(
        request,
        response,
        auth === undefined
          ? index
          : {
              ...index,
              body: Buffer.from(
                String(index.body).replace("<head>", `<head>${SWITCH_TOKEN_SCRIPT}`),
              ),
            },
      );
      return;
    }
    if (pathname === "/plugins/events" && pluginRuntime !== undefined) {
      await pluginRuntime.events(request, response);
      return;
    }
    if (shellReload !== undefined && pathname === SHELL_EVENTS_PATH) {
      shellReload.connect(request, response);
      return;
    }
    if (pathname.startsWith("/plugins/")) {
      await send(
        request,
        response,
        assets.plugin(url) ?? recoveryAssets.plugin(url),
        url.includes("rev=") ? IMMUTABLE_CACHE : undefined,
      );
      return;
    }
    if (pathname === "/harness-icons/presentation.json") {
      const plugins = await sessions.catalog.list();
      await send(
        request,
        response,
        {
          contentType: "application/json",
          body: Buffer.from(JSON.stringify(harnessIconStyles(plugins))),
        },
        HARNESS_ICON_CACHE,
      );
      return;
    }
    if (pathname.startsWith("/harness-icons/")) {
      const id = decodeURIComponent(pathname.slice("/harness-icons/".length));
      await send(
        request,
        response,
        id === "codex" ? assets.dist("/codex.png") : await sessions.catalog.icon(id),
        HARNESS_ICON_CACHE,
      );
      return;
    }
    if (pluginRuntime !== undefined && (auth === undefined || requestAuth !== undefined)) {
      if (request.method !== "GET" && request.method !== "HEAD" && !trust.sameOrigin(request)) {
        response.writeHead(403).end("cross-origin request rejected");
        return;
      }
      if (await pluginRuntime.handle(request, response)) return;
    }
    await send(
      request,
      response,
      assets.dist(pathname),
      pathname.startsWith("/assets/") ? IMMUTABLE_CACHE : undefined,
    );
  })().catch((error: unknown) => {
    console.error("[http] request failed", error);
    if (!response.headersSent) response.writeHead(500).end("internal error");
    else response.destroy();
  });
});

const relay = new RemoteRelay(data, accessTokens !== undefined, server, trust);
registerRelayRpc(rpc, accessTokens, () => listeningPort, relay);
if (serviceOptions.relayEnabled) relay.start();

const wss = createBrowserWebSocketServer();
const sidebarBrowser = new SidebarBrowser({ profileDirectory: join(dataRoot, "sidebar-browser") });
server.on("upgrade", (request, socket, head) => {
  const path = (request.url ?? "").split("?")[0];
  if (!trust.sameOrigin(request)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (auth !== undefined && !auth.admitUpgrade(request, socket)) return;
  if (path === SIDEBAR_BROWSER_PATH) sidebarBrowser.upgrade(request, socket, head);
  else if (path === "/api/remote.mux")
    wss.handleUpgrade(request, socket, head, (ws) =>
      streams.attach(ws, trust.relaySockets.has(request.socket)),
    );
  else {
    void (pluginRuntime?.upgrade(request, socket, head) ?? Promise.resolve(false))
      .then((handled) => {
        if (!handled) socket.destroy();
      })
      .catch((error: unknown) => {
        console.warn("[extensions] upgrade failed", error);
        socket.destroy();
      });
  }
});

if (background) {
  server.once("error", (error: NodeJS.ErrnoException) => {
    console.error(
      error.code === "EADDRINUSE"
        ? `Web port ${values.port} is in use; use --port to select another port`
        : error.message,
    );
    process.exit(1);
  });
}
server.listen(Number(values.port), values.host, async () => {
  const port = (server.address() as { port: number }).port;
  listeningPort = port;
  const host = values.host as string;
  const wildcard = isWildcardHost(host);
  // The local token works only on a local address, so a specific interface's link carries none.
  const local = wildcard || isLoopbackHost(host);
  const query = accessTokens !== undefined && local ? `?token=${accessTokens.localToken}` : "";
  const localUrl = `http://${wildcard ? "127.0.0.1" : host}:${String(port)}/${query}`;
  if (background) {
    const readyFile = values["ready-file"];
    if (readyFile !== undefined) {
      new DataDir(dirname(readyFile)).writeJson(
        basename(readyFile),
        {
          address: localUrl.split("?")[0],
          loginUrl: localUrl,
        },
        { mode: 0o600 },
      );
    }
  }
  console.log(`codexhost web: ${localUrl}`);
  const urls = reachableNetworkUrls(
    accessTokens !== undefined && local
      ? (await readNetworkAccess()).networkUrls
      : [...publicUrls, ...networkAccessUrls(host, port)],
  );
  if (accessTokens !== undefined && local) {
    setInterval(async () => {
      trust.trustLoopback = (await tailscaleServeState(port)).status === "serving";
    }, 30_000);
  }
  const printStartup = (qrCode?: string) =>
    console.log(
      formatWebStartup({
        networkUrls: urls,
        ...(qrCode === undefined ? {} : { qrCode }),
        ...(accessTokens !== undefined && !local ? { localManagementUnavailable: true } : {}),
      }),
    );
  if (devWebUi !== undefined)
    console.log(`  dev Web UI: ${devWebUi} (rebuilt bundles reload live)`);
  const preferred = urls[0];
  if (preferred !== undefined && process.stdout.isTTY) {
    qrcode.generate(preferred.url, { small: true }, printStartup);
  } else {
    printStartup();
  }
  // Warm Harness inspection so the first composer render already has models.
  if (values["import-recent"] !== undefined) {
    void sessions.importRecent(Number(values["import-recent"])).then((count) => {
      if (count > 0) console.log(`  imported ${String(count)} native session(s)`);
    });
  }
  // Shared mode asks the canonical owner; even inspection must not construct a
  // second set of Adapters inside the Web gateway.
  void sessions.catalog.models().catch((error: unknown) => {
    console.log(`  catalog unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });
});

async function shutdown(exitCode = 0): Promise<void> {
  relay.close();
  shellReload?.close();
  accessTokens?.close();
  server.close();
  desktopScreenshots.close();
  await sidebarBrowser.close();
  await dsh?.close();
  await extensions.cleanup(true);
  pushNotifications?.close();
  await sessions.close();
  remoteSessions.close();
  await preferences?.close();
  displaySettings.close();
  process.exit(exitCode);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
