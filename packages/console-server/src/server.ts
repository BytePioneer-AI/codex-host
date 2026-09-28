import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";

import { isConsoleHostMethod } from "@codexhost/shared-contracts";
import { allowedChange, allowedHost, CONSOLE_REQUEST_HEADER } from "./request-guard.js";
import {
  listLogFiles,
  processIsAlive,
  readControllerStatus,
  readLogTail,
  readStartupRecords,
  summarize,
} from "./diagnostics.js";
import {
  inspectInstallation,
  launchCommand,
  type ConsoleInstallation,
  type InspectDocument,
} from "./installation.js";
import { buildDiagnosticReport, issueUrl, serializeDiagnosticReport } from "./diagnostic-report.js";
import { ConsoleHarnessError, type ConsoleHarnesses } from "./harnesses.js";
import { HostUnavailableError, type ConsoleHostClient } from "./host-client.js";
import { CONSOLE_PAGE_CSS, CONSOLE_PAGE_HTML } from "./page.js";
import type { ConsolePaths } from "./paths.js";
import { ConsoleUpdateError, type ConsoleUpdates } from "./updates.js";

export const CONSOLE_SERVICE = "codexhost-console";
const MAX_BODY_BYTES = 16 * 1024;
const INSPECT_CACHE_MS = 2_000;

export interface ConsoleServerOptions {
  port: number;
  version: string;
  /** Identifies the running code; a different build replaces this console. */
  buildId?: string;
  installation: ConsoleInstallation;
  paths: ConsolePaths;
  updates: ConsoleUpdates;
  harnesses: ConsoleHarnesses;
  /** The console page bundle. */
  pageScript: string;
  /** The running Host's settings channel, when codexhost runs. */
  host: ConsoleHostClient;
  environment?: NodeJS.ProcessEnv;
  /** Exit after this long without requests. */
  idleTimeoutMs?: number;
  inspect?(launcherExecutable: string): Promise<InspectDocument>;
  launch?(command: string, args: string[]): void;
  onExit(): void;
}

export interface RunningConsoleServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
} as const;

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, "application/json; charset=utf-8", `${JSON.stringify(value)}\n`);
}

class RequestBodyError extends Error {}

/** Bounded JSON object body; an empty body is `{}`. */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RequestBodyError("Request body is too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Reported below.
  }
  throw new RequestBodyError("Request body must be a JSON object");
}

function defaultLaunch(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

export function startConsoleServer(options: ConsoleServerOptions): Promise<RunningConsoleServer> {
  const environment = options.environment ?? process.env;
  const inspect = options.inspect ?? inspectInstallation;
  const launch = options.launch ?? defaultLaunch;
  // Updated with the bound port; tests may listen on port 0.
  let port = options.port;
  let inspectCache: { at: number; value: Promise<InspectDocument> } | null = null;
  let idleTimer: NodeJS.Timeout | undefined;
  let exiting = false;

  // The console stays available while codexhost runs; afterwards it exits when idle.
  const scheduleIdleExit = (): void => {
    if (!options.idleTimeoutMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void loadInspect().then(
        (document) => (document.runtime.running ? scheduleIdleExit() : exit()),
        () => exit(),
      );
    }, options.idleTimeoutMs);
    idleTimer.unref();
  };

  const loadInspect = (): Promise<InspectDocument> => {
    const launcher = options.installation.launcherExecutable;
    if (!launcher) return Promise.reject(new Error("codexhost Launcher was not found"));
    const now = Date.now();
    if (!inspectCache || now - inspectCache.at > INSPECT_CACHE_MS) {
      const value = inspect(launcher);
      value.catch(() => undefined);
      inspectCache = { at: now, value };
    }
    return inspectCache.value;
  };

  const updateTarget = async () => {
    const document = await loadInspect().catch(() => null);
    return {
      distribution: options.installation.distribution,
      appDirectory: options.installation.appDirectory,
      runtimeDescriptorPath: document?.runtime.descriptorPath ?? null,
      codexhostRunning: document?.runtime.running ?? false,
    };
  };

  async function collect() {
    const [inspectResult, startup, controller, logs] = await Promise.all([
      loadInspect().then(
        (value) => ({ value, error: null as string | null }),
        (error: unknown) => ({
          value: null,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
      readStartupRecords(options.paths.startupRecordFile),
      readControllerStatus(options.paths.controllerStatusFile),
      listLogFiles(options.paths.logsDirectory),
    ]);
    const inspectDocument = inspectResult.value;
    const controllerAlive = controller !== null && processIsAlive(controller.pid);
    const summary = summarize({
      running: inspectDocument?.runtime.running ?? false,
      desktopError: inspectDocument?.desktopError ?? null,
      latestStartup: startup[0] ?? null,
      controller,
      controllerAlive,
    });
    return {
      inspectDocument,
      inspectError: inspectResult.error,
      startup,
      controller,
      controllerAlive,
      logs,
      summary,
    };
  }

  async function overview(): Promise<unknown> {
    const collected = await collect();
    const { inspectDocument, inspectError, startup, controller, controllerAlive, logs, summary } =
      collected;
    // A plain link opens reliably; a window opened after a request can be blocked.
    const reportIssueUrl = issueUrl(await diagnosticReport(collected, false));
    return {
      console: {
        service: CONSOLE_SERVICE,
        version: options.version,
        pid: process.pid,
        port,
        appDirectory: options.installation.appDirectory,
        distribution: options.installation.distribution,
      },
      homeDirectory: os.homedir(),
      inspect: inspectDocument,
      inspectError,
      startup,
      controller,
      controllerAlive,
      logs,
      launchAvailable: launchCommand(options.installation, environment) !== null,
      summary,
      issueUrl: reportIssueUrl,
      hostAvailable: await options.host.available(),
    };
  }

  async function diagnosticReport(
    collected?: Awaited<ReturnType<typeof collect>>,
    withLogs = true,
  ) {
    collected ??= await collect();
    return buildDiagnosticReport(
      {
        consoleVersion: options.version,
        distribution: options.installation.distribution,
        summary: collected.summary,
        inspect: collected.inspectDocument,
        inspectError: collected.inspectError,
        startup: collected.startup,
        controller: collected.controller,
        controllerAlive: collected.controllerAlive,
        logs: withLogs ? collected.logs : [],
      },
      (name, maxBytes) => readLogTail(options.paths.logsDirectory, name, maxBytes),
    );
  }

  function exit(): void {
    if (exiting) return;
    exiting = true;
    options.onExit();
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!allowedHost(request.headers.host, port)) {
      sendJson(response, 421, { error: "Unexpected Host" });
      return;
    }
    scheduleIdleExit();
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const method = request.method ?? "GET";
    const route = `${method} ${url.pathname}`;

    if (route === "GET /api/health") {
      sendJson(response, 200, {
        service: CONSOLE_SERVICE,
        schemaVersion: 1,
        version: options.version,
        pid: process.pid,
        appDirectory: options.installation.appDirectory,
        buildId: options.buildId ?? null,
      });
      return;
    }

    if (method === "GET" && url.pathname === "/") {
      send(response, 200, "text/html; charset=utf-8", CONSOLE_PAGE_HTML);
      return;
    }
    if (route === "GET /app.js") {
      send(response, 200, "text/javascript; charset=utf-8", options.pageScript);
      return;
    }
    if (route === "GET /app.css") {
      send(response, 200, "text/css; charset=utf-8", CONSOLE_PAGE_CSS);
      return;
    }

    let body: Record<string, unknown> = {};
    if (method !== "GET") {
      if (
        !allowedChange(
          request.headers.origin,
          headerValue(request.headers[CONSOLE_REQUEST_HEADER]),
          port,
        )
      ) {
        sendJson(response, 403, { error: "Forbidden" });
        return;
      }
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { error: (error as Error).message });
        return;
      }
    }

    if (route === "POST /api/shutdown") {
      sendJson(response, 200, { ok: true });
      setImmediate(exit);
      return;
    }
    if (route === "GET /api/overview") {
      sendJson(response, 200, await overview());
      return;
    }
    if (
      route === "POST /api/update/check" ||
      route === "GET /api/update/status" ||
      route === "POST /api/update/start"
    ) {
      // A running codexhost updates through its Host so the Launcher can hand over.
      const target = await updateTarget();
      if (target.codexhostRunning && (await options.host.available())) {
        const method =
          route === "POST /api/update/check"
            ? "codexhost/update/check"
            : route === "POST /api/update/start"
              ? "codexhost/update/start"
              : "codexhost/update/status";
        const reply = await options.host.request(method, {}).catch((error: unknown) => ({
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        }));
        if ("error" in reply) sendJson(response, 500, { error: reply.error.message });
        else sendJson(response, 200, reply.result);
        return;
      }
    }
    if (route === "POST /api/update/check") {
      sendJson(response, 200, await options.updates.check(await updateTarget()));
      return;
    }
    if (route === "GET /api/update/status") {
      sendJson(response, 200, await options.updates.status());
      return;
    }
    if (route === "POST /api/update/start") {
      try {
        sendJson(response, 200, await options.updates.start(await updateTarget()));
      } catch (error) {
        const status =
          error instanceof ConsoleUpdateError && error.code === "codex-running" ? 409 : 500;
        sendJson(response, status, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (route === "GET /api/host") {
      sendJson(response, 200, { available: await options.host.available() });
      return;
    }
    if (route === "POST /api/host/request") {
      const method = body.method;
      if (typeof method !== "string" || !isConsoleHostMethod(method)) {
        sendJson(response, 400, { error: { code: -32601, message: "Method is not available" } });
        return;
      }
      try {
        sendJson(response, 200, await options.host.request(method, body.params ?? {}));
      } catch (error) {
        sendJson(response, error instanceof HostUnavailableError ? 503 : 502, {
          error: {
            code: error instanceof HostUnavailableError ? -32090 : -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }
    if (route === "GET /api/diagnostics/export") {
      const report = await diagnosticReport();
      const stamp = report.generatedAt.replace(/[:.]/gu, "-");
      send(response, 200, "application/json; charset=utf-8", serializeDiagnosticReport(report), {
        "content-disposition": `attachment; filename="codexhost-diagnostics-${stamp}.json"`,
      });
      return;
    }
    if (route === "GET /api/harnesses") {
      sendJson(response, 200, { harnesses: await options.harnesses.list() });
      return;
    }
    if (route === "POST /api/harnesses/launch-path") {
      const id = body.id;
      const value = body.path;
      if (typeof id !== "string" || !(value === null || typeof value === "string")) {
        sendJson(response, 400, { error: "Expected { id, path }" });
        return;
      }
      try {
        const harness = await options.harnesses.setLaunchPath(id, value === "" ? null : value);
        sendJson(response, 200, { harness });
      } catch (error) {
        sendJson(response, error instanceof ConsoleHarnessError ? error.status : 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (route === "POST /api/launch") {
      const command = launchCommand(options.installation, environment);
      if (!command) {
        sendJson(response, 409, { error: "This installation cannot be started from the console" });
        return;
      }
      launch(command.command, command.args);
      inspectCache = null;
      sendJson(response, 202, { started: true });
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      } else {
        response.destroy();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      scheduleIdleExit();
      const address = server.address();
      port = typeof address === "object" && address ? address.port : options.port;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((done) => {
            if (idleTimer) clearTimeout(idleTimer);
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
