/**
 * codexhost Web server entry point.
 *
 *   node --import tsx src/main.ts [--port 4400] [--host 127.0.0.1] [--data <dir>]
 *        [--adapters <dir>[,<dir>...]] [--harness <id>[,<id>...]]
 *        [--token <value>] [--trusted-proxy <ip>[,<ip>...]] [--no-auth]
 *        [--dev-web-ui <apps/web-ui>]
 *
 * `--dev-web-ui` serves the Web UI from that source checkout instead of the packed copy and pushes
 * rebuilt plugin bundles to open pages (used by `npm start web -- --watch`).
 */

import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import qrcode from "qrcode-terminal";
import { createBrowserWebSocketServer } from "./browser-websocket.ts";

import { registerAccessTokenRpc } from "./access-token-rpc.ts";
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
import { tailscaleServeAccessUrls } from "./tailscale-serve.ts";
import { RequestTrust } from "./request-trust.ts";
import { DESKTOP_SCREENSHOT_PATH } from "@codexhost/shared-contracts/desktop-screenshot";
import { DesktopScreenshots } from "./desktop-screenshot.ts";
import { SIDEBAR_BROWSER_PATH } from "@codexhost/shared-contracts/sidebar-browser";
import { SidebarBrowser } from "./sidebar-browser.ts";
import { registerMisc } from "./misc.ts";
import { PushNotifier } from "./push.ts";
import { CLIENT_GLOBALS, CLIENT_PLUGINS, HMR_CLIENT_PLUGIN } from "./plugins.ts";
import { ChSessions } from "./ch-sessions.ts";
import { WebHarnessDisplaySettings } from "./harness-display-settings.ts";
import { WebHarnessPreferences } from "./harness-preferences.ts";
import { createChHostClient } from "./ch-host-client.ts";
import { serveChClientGateway } from "./ch-client-gateway.ts";
import { DshWebServices } from "./dsh-web-services.ts";
import { harnessIconStyles } from "./harness-icon-styles.ts";
import { Settings } from "./settings.ts";
import { formatWebStartup } from "./startup-display.ts";
import { DataDir } from "./store.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "./transport.ts";
import { WebAssets, type AssetResponse, type WebAssetOptions } from "./web-assets.ts";
import { HMR_EVENTS_PATH, WebHmr } from "./web-hmr.ts";
import { Workspaces } from "./workspaces.ts";
import { inspectImage, readImageFile, WebImages } from "./web-images.ts";
import { WebFiles } from "./web-files.ts";
import { serveFileUpload } from "./ch-file-upload-http.ts";
import { registerVoiceStatus, serveVoiceTranscription } from "./voice-http.ts";
import { defaultWebDataDirectory } from "./data-paths.ts";
import { snapshotPackagedHost } from "./packaged-host.ts";

/** Packed distribution: app/server.mjs shares a root with web/, adapters/ and native/. */
const DISTRIBUTION_ROOT = resolve(import.meta.dirname, "..");
const PACKED_WEB = join(DISTRIBUTION_ROOT, "web");
const PACKED = existsSync(join(PACKED_WEB, "plugins.json"));
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
// A packed Web distribution ships the subprocess runner as JavaScript beside
// the server bundle; the source package's TypeScript entry is not runnable.
if (PACKED) {
  const runner = join(DISTRIBUTION_ROOT, "app/subprocess-runner.mjs");
  if (existsSync(runner)) process.env.CODEXHOST_SUBPROCESS_RUNNER ??= runner;
}
function defaultAdapterRoots(): string {
  return PACKED
    ? join(DISTRIBUTION_ROOT, "adapters")
    : resolve(REPO_ROOT, "packages/host-runtime/dist/plugins");
}

const { values } = parseArgs({
  options: {
    "session-source": { type: "string", default: "codexhost" },
    "ch-cdp": { type: "string" },
    "ch-control-directory": { type: "string" },
    "ch-launcher": { type: "string" },
    "ch-host-runtime": { type: "string" },
    "ch-data": { type: "string" },
    "ch-codex-home": { type: "string" },
    "ch-plugins": { type: "string" },
    port: { type: "string", default: process.env.CODEXHOST_WEB_PORT ?? "4400" },
    host: { type: "string", default: process.env.CODEXHOST_WEB_HOST ?? "127.0.0.1" },
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
    "trusted-proxy": { type: "string", default: process.env.CODEXHOST_WEB_TRUSTED_PROXIES },
    "no-auth": { type: "boolean", default: false },
    "import-recent": { type: "string", default: process.env.CODEXHOST_IMPORT_RECENT },
    "dev-web-ui": { type: "string" },
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
const trust = new RequestTrust(values["trusted-proxy"]);
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
  PACKED && !values["ch-cdp"]
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
const desktopScreenshots = new DesktopScreenshots([launcher]);
const chHost = await createChHostClient({
  launch: {
    launcher,
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
sessions.notifier = (notification) => {
  void push.notify({
    kind: notification.kind,
    title: notification.title,
    body: notification.body,
    tag: notification.sessionId,
    sessionId: notification.sessionId,
    url: `./?session=${encodeURIComponent(notification.sessionId)}`,
  });
};
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
        plugins: devWebUi === undefined ? CLIENT_PLUGINS : [...CLIENT_PLUGINS, HMR_CLIENT_PLUGIN],
        globals: CLIENT_GLOBALS,
        title: "CodexHost",
      };
const builtInAssets = new WebAssets(assetOptions);
const recoveryAssets =
  devWebUi === undefined
    ? builtInAssets
    : new WebAssets({
        ...assetOptions,
        plugins: CLIENT_PLUGINS,
      });
const extensions = new WebUiExtensions(data, {
  safeMode: values["safe-mode"],
  validate: (externalPlugins) => {
    new WebAssets({ ...assetOptions, externalPlugins });
  },
});
let assets = builtInAssets;
if (!values["safe-mode"]) {
  try {
    const externalPlugins = extensions.plugins();
    if (externalPlugins.length > 0) assets = new WebAssets({ ...assetOptions, externalPlugins });
    extensions.composed(externalPlugins.map((plugin) => plugin.id));
  } catch (error) {
    extensions.composed(
      [],
      error instanceof Error ? error.message : "Extension composition failed.",
    );
    console.warn("[extensions] using built-in UI; manage extensions at /extensions");
  }
}
const hmr = devWebUi === undefined ? undefined : new WebHmr(assets);

streams.register("$events", events.handler);
workspaces.register(rpc, streams);
sessions.register(rpc, streams);
sessions.registerCommands(rpc);
sessions.registerImport(rpc);
preferences.register(rpc);
displaySettings.register(rpc);
settings.register(rpc);
push.register(rpc);
registerAccessTokenRpc(rpc, accessTokens, {
  port: () => (server.address() as { port: number }).port,
  networkUrls: async () => {
    const host = values.host as string;
    const { port } = server.address() as { port: number };
    return [...(await tailscaleServeAccessUrls(host, port)), ...networkAccessUrls(host, port)];
  },
});
registerMisc(rpc, { events });
registerUiExtensionRpc(rpc, extensions, {
  port: () => (server.address() as { port: number }).port,
});
registerVoiceStatus(rpc, chHost);

function send(response: ServerResponse, asset: AssetResponse | undefined, cache = false): void {
  if (asset === undefined) {
    response.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  response
    .writeHead(200, {
      "content-type": asset.contentType,
      "cache-control": cache ? "public, max-age=31536000, immutable" : "no-cache",
    })
    .end(asset.body);
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

const server = createServer((request, response) => {
  const url = request.url ?? "/";
  const pathname = url.split("?")[0] ?? "/";
  void (async () => {
    response.setHeader("X-Content-Type-Options", "nosniff");
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
      const reply = await rpc.handleHttp(body, requestAuth);
      response
        .writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        })
        .end(reply);
      return;
    }
    if (pathname === "/extensions") {
      send(response, {
        contentType: "text/html; charset=utf-8",
        body: Buffer.from(UI_EXTENSION_PAGE),
      });
      return;
    }
    if (pathname === "/" || pathname === "/index.html") {
      const builtInOnly = new URL(url, "http://localhost").searchParams.get("extensions") === "off";
      const index = (builtInOnly ? recoveryAssets : assets).index();
      send(
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
    if (hmr !== undefined && pathname === HMR_EVENTS_PATH) {
      hmr.connect(request, response);
      return;
    }
    if (pathname.startsWith("/plugins/")) {
      send(response, assets.plugin(url), url.includes("rev="));
      return;
    }
    if (pathname === "/harness-icons/presentation.json") {
      const plugins = await sessions.catalog.list();
      send(response, {
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(harnessIconStyles(plugins))),
      });
      return;
    }
    if (pathname.startsWith("/harness-icons/")) {
      const id = decodeURIComponent(pathname.slice("/harness-icons/".length));
      send(response, await sessions.catalog.icon(id));
      return;
    }
    send(response, assets.dist(pathname), pathname.startsWith("/assets/"));
  })().catch((error: unknown) => {
    console.error("[http] request failed", error);
    if (!response.headersSent) response.writeHead(500).end("internal error");
  });
});

const wss = createBrowserWebSocketServer();
const sidebarBrowser = new SidebarBrowser({ profileDirectory: join(dataRoot, "sidebar-browser") });
server.on("upgrade", (request, socket, head) => {
  const path = (request.url ?? "").split("?")[0];
  if ((path !== SIDEBAR_BROWSER_PATH && path !== "/api/remote.mux") || !trust.sameOrigin(request)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (auth !== undefined && !auth.admitUpgrade(request, socket)) return;
  if (path === SIDEBAR_BROWSER_PATH) sidebarBrowser.upgrade(request, socket, head);
  else wss.handleUpgrade(request, socket, head, (ws) => streams.attach(ws));
});

server.listen(Number(values.port), values.host, () => {
  const port = (server.address() as { port: number }).port;
  const host = values.host as string;
  const wildcard = isWildcardHost(host);
  // The local token works only on a local address, so a specific interface's link carries none.
  const local = wildcard || isLoopbackHost(host);
  const query = accessTokens !== undefined && local ? `?token=${accessTokens.localToken}` : "";
  const localUrl = `http://${wildcard ? "127.0.0.1" : host}:${String(port)}/${query}`;
  const urls = reachableNetworkUrls(networkAccessUrls(host, port));
  const printStartup = (qrCode?: string) =>
    console.log(
      formatWebStartup({
        localUrl,
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

async function shutdown(): Promise<void> {
  hmr?.close();
  accessTokens?.close();
  server.close();
  desktopScreenshots.close();
  await sidebarBrowser.close();
  await dsh?.close();
  await sessions.close();
  await preferences?.close();
  displaySettings.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
