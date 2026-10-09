/**
 * codexhost Web server entry point.
 *
 *   node --import tsx src/main.ts [--port 3180] [--host 127.0.0.1] [--data <dir>]
 *        [--adapters <dir>[,<dir>...]] [--harness <id>[,<id>...]]
 *        [--token <value>] [--rotate-token] [--no-auth]
 */

import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import qrcode from "qrcode-terminal";
import { WebSocketServer } from "ws";

import { AccessAuth } from "./auth.ts";
import { HarnessRegistry } from "./harnesses.ts";
import { registerMisc } from "./misc.ts";
import { PushNotifier } from "./push.ts";
import { CLIENT_GLOBALS, CLIENT_PLUGINS } from "./plugins.ts";
import { Sessions } from "./sessions.ts";
import { Settings } from "./settings.ts";
import { DataDir } from "./store.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "./transport.ts";
import { WebAssets, type AssetResponse } from "./web-assets.ts";
import { Workspaces } from "./workspaces.ts";

/** Packed distribution: `server.mjs` sits next to `web/plugins.json`. */
const PACKED_WEB = resolve(import.meta.dirname, "web");
const PACKED = existsSync(join(PACKED_WEB, "plugins.json"));
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
function defaultAdapterRoots(): string {
  return PACKED
    ? resolve(import.meta.dirname, "adapters")
    : resolve(REPO_ROOT, "packages/host-runtime/dist/plugins");
}

const { values } = parseArgs({
  options: {
    port: { type: "string", default: process.env.CODEXHOST_WEB_PORT ?? "3180" },
    host: { type: "string", default: process.env.CODEXHOST_WEB_HOST ?? "127.0.0.1" },
    data: {
      type: "string",
      default: process.env.CODEXHOST_WEB_DATA ?? join(homedir(), ".codexhost-web"),
    },
    adapters: { type: "string", default: process.env.CODEXHOST_ADAPTERS ?? defaultAdapterRoots() },
    harness: { type: "string", default: process.env.CODEXHOST_HARNESSES },
    workspace: {
      type: "string",
      default: process.env.CODEXHOST_DEFAULT_WORKSPACE ?? join(homedir(), "codexhost-workspace"),
    },
    token: { type: "string", default: process.env.CODEXHOST_WEB_TOKEN },
    "rotate-token": { type: "boolean", default: false },
    "no-auth": { type: "boolean", default: false },
    "import-recent": { type: "string", default: process.env.CODEXHOST_IMPORT_RECENT },
  },
  allowPositionals: false,
});

const data = new DataDir(resolve(values.data as string));
const auth =
  values["no-auth"] === true
    ? undefined
    : new AccessAuth(data, {
        rotate: values["rotate-token"],
        ...(values.token === undefined ? {} : { token: values.token }),
      });
const rpc = new RpcRegistry();
const streams = new StreamRegistry();
const events = new EventHub(homedir());
const harnesses = new HarnessRegistry(
  (values.adapters as string).split(",").map((path) => resolve(path)),
  values.harness === undefined ? undefined : new Set(values.harness.split(",")),
);
const workspaces = new Workspaces(data, resolve(values.workspace as string));
const sessions = new Sessions(data, harnesses, workspaces, events);
const settings = new Settings(data, events);
const push = new PushNotifier(data);
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
const assets = PACKED
  ? new WebAssets({
      packedRoot: PACKED_WEB,
      plugins: [],
      globals: CLIENT_GLOBALS,
      title: "CodexHost",
    })
  : new WebAssets({
      repoRoot: resolve(REPO_ROOT, "apps/web-ui"),
      plugins: CLIENT_PLUGINS,
      globals: CLIENT_GLOBALS,
      title: "CodexHost",
    });

streams.register("$events", events.handler);
workspaces.register(rpc, streams);
sessions.register(rpc, streams);
sessions.registerCommands(rpc);
sessions.registerImport(rpc);
settings.register(rpc);
push.register(rpc);
registerMisc(rpc, { harnesses, sessions, events });

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

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reject cross-origin browser requests (CSRF / cross-site WebSocket hijacking). Requests without
 * an Origin header (native clients, curl) are allowed; they still need the access token.
 */
function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined || origin === "null") return origin === undefined;
  try {
    const forwardedHost = request.headers["x-forwarded-host"];
    const host =
      (typeof forwardedHost === "string" ? forwardedHost.split(",")[0]?.trim() : undefined) ??
      request.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const server = createServer((request, response) => {
  const url = request.url ?? "/";
  const pathname = url.split("?")[0] ?? "/";
  void (async () => {
    if (auth !== undefined) {
      if ((pathname === "/" || pathname === "/index.html") && auth.exchange(request, response))
        return;
      if (!auth.authorized(request)) {
        // Static shell assets carry no data; everything else (and the document) needs the token.
        const publicAsset =
          pathname.startsWith("/assets/") ||
          /^\/(favicon[^/]*\.svg|manifest\.webmanifest|apple-touch-icon\.png|icon-\d+\.png|sw\.js)$/u.test(
            pathname,
          );
        if (!publicAsset) {
          if (pathname.startsWith("/api/") || pathname.startsWith("/plugins/")) {
            response
              .writeHead(401, { "content-type": "text/plain", "cache-control": "no-store" })
              .end("authentication required");
          } else {
            auth.signInPage(response);
          }
          return;
        }
      }
    }
    if (request.method === "POST" && pathname.startsWith("/api/")) {
      if (!sameOrigin(request)) {
        response
          .writeHead(403, { "content-type": "text/plain" })
          .end("cross-origin request rejected");
        return;
      }
      const body = await readBody(request);
      const reply = await rpc.handleHttp(body);
      response
        .writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        })
        .end(reply);
      return;
    }
    if (pathname === "/" || pathname === "/index.html") {
      send(response, assets.index());
      return;
    }
    if (pathname.startsWith("/plugins/")) {
      send(response, assets.plugin(url), url.includes("rev="));
      return;
    }
    if (pathname.startsWith("/harness-icons/")) {
      const icon = harnesses.iconPath(decodeURIComponent(pathname.slice("/harness-icons/".length)));
      send(
        response,
        icon === undefined || !existsSync(icon)
          ? undefined
          : { body: readFileSync(icon), contentType: "image/svg+xml" },
      );
      return;
    }
    send(response, assets.dist(pathname), pathname.startsWith("/assets/"));
  })().catch((error: unknown) => {
    console.error("[http] request failed", error);
    if (!response.headersSent) response.writeHead(500).end("internal error");
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
server.on("upgrade", (request, socket, head) => {
  if (
    (request.url ?? "").split("?")[0] !== "/api/remote.mux" ||
    !sameOrigin(request) ||
    (auth !== undefined && !auth.authorized(request))
  ) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => streams.attach(ws));
});

server.listen(Number(values.port), values.host, () => {
  const port = (server.address() as { port: number }).port;
  const query = auth === undefined ? "" : `?token=${auth.token}`;
  const wildcard = values.host === "0.0.0.0" || values.host === "::";
  console.log(
    `codexhost web: http://${wildcard ? "127.0.0.1" : (values.host as string)}:${String(port)}/${query}`,
  );
  if (wildcard) {
    // Tailscale hands out CGNAT addresses (100.64.0.0/10): reachable from the phone on any network.
    const isTailscale = (ip: string): boolean => {
      const [a, b] = ip.split(".").map(Number);
      return a === 100 && b !== undefined && b >= 64 && b <= 127;
    };
    const urls: Array<{ kind: "tailscale" | "lan"; url: string }> = [];
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family !== "IPv4" || address.internal) continue;
        urls.push({
          kind: isTailscale(address.address) ? "tailscale" : "lan",
          url: `http://${address.address}:${String(port)}/${query}`,
        });
      }
    }
    urls.sort((a, b) => Number(b.kind === "tailscale") - Number(a.kind === "tailscale"));
    for (const entry of urls)
      console.log(`  ${entry.kind === "tailscale" ? "tailscale" : "lan"}: ${entry.url}`);
    const preferred = urls[0];
    if (preferred !== undefined && process.stdout.isTTY) {
      console.log(
        preferred.kind === "tailscale"
          ? "  Scan with your phone (any network with Tailscale on):"
          : "  Scan with your phone (same Wi-Fi):",
      );
      qrcode.generate(preferred.url, { small: true }, (code: string) =>
        console.log(code.replace(/^/gmu, "  ")),
      );
    }
  }
  console.log(`  data: ${data.root}`);
  console.log(`  harnesses: ${harnesses.ids().join(", ") || "(none found)"}`);
  // Warm Harness inspection so the first composer render already has models.
  if (values["import-recent"] !== undefined) {
    void sessions.importRecent(Number(values["import-recent"])).then((count) => {
      if (count > 0) console.log(`  imported ${String(count)} native session(s)`);
    });
  }
  void harnesses.modelCatalog().then((catalog) => {
    console.log(
      `  ready: ${catalog.groups.map((group) => `${group.name} (${String(group.models.length)} models)`).join(", ") || "none"}`,
    );
    for (const failure of catalog.failures)
      console.log(`  unavailable: ${failure.name}: ${failure.message}`);
  });
});

async function shutdown(): Promise<void> {
  server.close();
  await sessions.close();
  await harnesses.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
