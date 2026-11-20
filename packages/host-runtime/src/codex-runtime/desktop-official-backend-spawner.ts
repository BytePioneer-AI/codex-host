import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import type { AddressInfo } from "node:net";

import type { OfficialAppServerExit } from "../official-app-server-connection.js";
import { OfficialProcessStopTimeoutError } from "../official-process-lifecycle.js";
import {
  createAuthenticatedLoopbackOfficialAppServerListener,
  type LoopbackOfficialAppServerListener,
} from "../remote-official-app-server.js";
import { createRemoteOfficialAppServerConnection } from "../remote-official-connection.js";
import type { OwnedOfficialBackend } from "./official-runtime-owner.js";

const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const MAX_START_REQUEST_BYTES = 1024 * 1024;
const PID_POLL_INTERVAL_MS = 50;

export interface DesktopOfficialBackendSpawnerDescriptor {
  port: number;
  token: string;
}

export interface DesktopOfficialBackendSpawner {
  readonly descriptor: DesktopOfficialBackendSpawnerDescriptor;
  detach(): Promise<void>;
}

/** Raised only when the Desktop bridge spawner is unreachable or shutting down. */
export class DesktopOfficialSpawnerUnreachableError extends Error {
  constructor(message = "Desktop official backend spawner is unavailable") {
    super(message);
    this.name = "DesktopOfficialSpawnerUnreachableError";
  }
}

class DesktopOfficialBackendNotFoundError extends Error {
  constructor(message = "Desktop official backend was not found") {
    super(message);
    this.name = "DesktopOfficialBackendNotFoundError";
  }
}

export function isDesktopOfficialBackendSpawnerDescriptor(
  value: unknown,
): value is DesktopOfficialBackendSpawnerDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  return (
    keys.every((key) => key === "port" || key === "token") &&
    typeof candidate.port === "number" &&
    Number.isInteger(candidate.port) &&
    candidate.port >= 1 &&
    candidate.port <= 65_535 &&
    typeof candidate.token === "string" &&
    candidate.token.length > 0
  );
}

interface StartBackendRequest {
  cwd?: string;
  stockCodexPath: string;
  arguments: string[];
  environment: NodeJS.ProcessEnv;
}

interface StartBackendResponse {
  id: string;
  endpoint: string;
  capabilityToken: string;
  processId?: number;
}

interface ExitPayload {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseStartBackendRequest(raw: unknown): StartBackendRequest {
  if (!isPlainObject(raw)) throw new Error("Invalid start backend payload");
  if (typeof raw.stockCodexPath !== "string" || !raw.stockCodexPath) {
    throw new Error("Official Codex path is required");
  }
  if (!Array.isArray(raw.arguments) || !raw.arguments.every((entry) => typeof entry === "string")) {
    throw new Error("Official Codex arguments must be strings");
  }
  if (!isPlainObject(raw.environment)) {
    throw new Error("Official Codex environment must be an object");
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, entry] of Object.entries(raw.environment)) {
    if (entry === undefined) continue;
    if (typeof entry !== "string") {
      throw new Error("Official Codex environment values must be strings");
    }
    environment[key] = entry;
  }
  if (raw.cwd !== undefined && typeof raw.cwd !== "string") {
    throw new Error("Official Codex cwd must be a string");
  }
  return {
    ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
    stockCodexPath: raw.stockCodexPath,
    arguments: raw.arguments as string[],
    environment,
  };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_START_REQUEST_BYTES) {
      throw new Error("Official backend request exceeds size limit");
    }
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isPlainObject(parsed)) throw new Error("Expected a JSON object");
  return parsed;
}

function toExitPayload(exit: OfficialAppServerExit): ExitPayload {
  return {
    code: exit.code,
    signal: exit.signal,
    ...(exit.error ? { error: exit.error.message } : {}),
  };
}

function fromExitPayload(payload: ExitPayload): OfficialAppServerExit {
  return {
    code: payload.code,
    signal: payload.signal,
    ...(payload.error ? { error: new Error(payload.error) } : {}),
  };
}

/**
 * Exposes a private loopback endpoint inside Desktop's process tree so Shared Host
 * can spawn the shared official `codex app-server` under Desktop OS ancestry while
 * keeping Shared Host as the sole protocol/WebSocket coordinator.
 */
export async function startDesktopOfficialBackendSpawner(
  options: {
    spawnOfficial?: typeof spawn;
    closeTimeoutMs?: number;
    listenTimeoutMs?: number;
  } = {},
): Promise<DesktopOfficialBackendSpawner> {
  const spawnOfficial = options.spawnOfficial ?? spawn;
  const token = randomBytes(32).toString("hex");
  const expectedToken = Buffer.from(token);
  const entries = new Map<
    string,
    { child: ChildProcess | null; listener: LoopbackOfficialAppServerListener }
  >();
  const waiters = new Set<() => void>();
  let detaching = false;
  let detached: Promise<void> | undefined;

  const authorized = (request: IncomingMessage): boolean => {
    const authorization = request.headers.authorization;
    const provided = Buffer.from(
      authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "",
    );
    return (
      !request.headers.origin &&
      provided.length === expectedToken.length &&
      timingSafeEqual(provided, expectedToken)
    );
  };

  const server = createServer((request, response) => {
    const reply = (status: number, body: unknown): void => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(body));
    };

    void (async () => {
      if (!authorized(request)) {
        reply(401, { error: "Unauthorized" });
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "POST" && url.pathname === "/v1/official-backend/start") {
        if (detaching) {
          reply(503, { error: "Desktop official backend spawner is closing" });
          return;
        }
        const parsed = parseStartBackendRequest(await readJsonBody(request));
        const id = randomUUID();
        const entry: { child: ChildProcess | null; listener: LoopbackOfficialAppServerListener } = {
          child: null,
          listener: undefined as unknown as LoopbackOfficialAppServerListener,
        };
        const { capabilityToken, listener } = createAuthenticatedLoopbackOfficialAppServerListener({
          ...parsed,
          ...(options.closeTimeoutMs === undefined
            ? {}
            : { closeTimeoutMs: options.closeTimeoutMs }),
          ...(options.listenTimeoutMs === undefined
            ? {}
            : { listenTimeoutMs: options.listenTimeoutMs }),
          spawnOfficial: ((
            command: string,
            args: readonly string[],
            spawnOptions: SpawnOptions,
          ): ChildProcess => {
            const spawned = spawnOfficial(command, args, spawnOptions);
            entry.child = spawned;
            return spawned;
          }) as unknown as typeof spawn,
        });
        entry.listener = listener;
        entries.set(id, entry);
        let endpoint: string;
        try {
          endpoint = await listener.listen();
        } catch (error) {
          entries.delete(id);
          reply(500, { error: errorMessage(error) });
          return;
        }
        if (detaching) {
          entries.delete(id);
          await listener.close().catch(() => undefined);
          reply(503, { error: "Desktop official backend spawner is closing" });
          return;
        }
        const payload: StartBackendResponse = {
          id,
          endpoint,
          capabilityToken,
          ...(listener.processId === undefined ? {} : { processId: listener.processId }),
        };
        reply(200, payload);
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/official-backend/wait") {
        const id = url.searchParams.get("id");
        const entry = id ? entries.get(id) : undefined;
        if (!entry) {
          reply(404, { error: "Official backend was not found" });
          return;
        }
        if (detaching) {
          reply(503, { error: "Desktop official backend spawner is closing" });
          return;
        }
        // Exit waits can outlive typical HTTP socket timeouts while a session stays open.
        request.socket.setTimeout(0);
        const result = await new Promise<
          { kind: "exit"; exit: OfficialAppServerExit } | { kind: "detached" }
        >((resolve) => {
          let settled = false;
          const finish = (
            outcome: { kind: "exit"; exit: OfficialAppServerExit } | { kind: "detached" },
          ) => {
            if (settled) return;
            settled = true;
            waiters.delete(onDetach);
            response.off("close", onDetach);
            resolve(outcome);
          };
          const onDetach = () => finish({ kind: "detached" });
          waiters.add(onDetach);
          response.once("close", onDetach);
          void entry.listener.closed.then((exit) => finish({ kind: "exit", exit }));
        });
        if (result.kind === "exit" && !detaching) {
          reply(200, toExitPayload(result.exit));
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/official-backend/stop") {
        const body = await readJsonBody(request);
        const id = typeof body.id === "string" ? body.id : undefined;
        const entry = id ? entries.get(id) : undefined;
        if (!id || !entry) {
          reply(404, { error: "Official backend was not found" });
          return;
        }
        await entry.listener.close();
        const exit = await entry.listener.closed;
        entries.delete(id);
        reply(200, { stopped: true, exit: toExitPayload(exit) });
        return;
      }

      reply(404, { error: "Not found" });
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        reply(400, { error: errorMessage(error) });
      } else {
        response.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      server.unref();
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address.port !== "number") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Desktop official backend spawner failed to bind");
  }

  return {
    descriptor: { port: address.port, token },
    detach() {
      if (detached) return detached;
      detached = (async () => {
        detaching = true;
        for (const notify of [...waiters]) notify();
        // Detach running children without terminating them so in-flight official
        // turns keep executing while the Desktop bridge process exits promptly.
        for (const { child } of entries.values()) {
          if (!child) continue;
          child.removeAllListeners();
          child.stderr?.removeAllListeners("data");
          child.stderr?.resume();
          (child.stderr as { unref?: () => void } | null)?.unref?.();
          child.unref();
        }
        entries.clear();
        server.closeAllConnections();
        if (server.listening) {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      })();
      return detached;
    },
  };
}

function loopbackHttpJson<T>(
  spawner: DesktopOfficialBackendSpawnerDescriptor,
  method: "GET" | "POST",
  urlPath: string,
  payload?: unknown,
  onRequest?: (request: ClientRequest) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const serialized = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: spawner.port,
        path: urlPath,
        method,
        agent: false,
        timeout: 0,
        headers: {
          authorization: `Bearer ${spawner.token}`,
          connection: "close",
          ...(serialized
            ? {
                "content-type": "application/json",
                "content-length": String(serialized.length),
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let aborted = false;
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });
        response.once("aborted", () => {
          aborted = true;
          reject(new DesktopOfficialSpawnerUnreachableError("Desktop spawner connection closed"));
        });
        response.once("error", (error) => {
          reject(new DesktopOfficialSpawnerUnreachableError(error.message));
        });
        response.once("end", () => {
          if (aborted) return;
          const status = response.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: Record<string, unknown> = {};
          try {
            const candidate: unknown = JSON.parse(text);
            if (isPlainObject(candidate)) parsed = candidate;
          } catch {
            // Non-JSON responses fall back to status reporting below.
          }
          const detail =
            typeof parsed.error === "string"
              ? parsed.error
              : `Desktop official backend spawner returned HTTP ${String(status)}`;
          if (status === 503) {
            reject(new DesktopOfficialSpawnerUnreachableError(detail));
            return;
          }
          if (status === 404) {
            reject(new DesktopOfficialBackendNotFoundError(detail));
            return;
          }
          if (status < 200 || status >= 300) {
            reject(new Error(detail));
            return;
          }
          resolve(parsed as T);
        });
      },
    );
    onRequest?.(request);
    request.once("error", (error) => {
      reject(new DesktopOfficialSpawnerUnreachableError(error.message));
    });
    if (serialized) request.write(serialized);
    request.end();
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Waiter checks actual PID disappearance below.
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, PID_POLL_INTERVAL_MS);
      timer.unref();
    });
    if (!isProcessAlive(pid)) return true;
  }
  return !isProcessAlive(pid);
}

async function terminateDetachedPid(
  pid: number,
  timeoutMs: number,
): Promise<OfficialAppServerExit> {
  if (!isProcessAlive(pid)) return { code: 0, signal: null };
  signalProcess(pid, "SIGTERM");
  if (await waitForPidExit(pid, timeoutMs)) return { code: null, signal: "SIGTERM" };
  signalProcess(pid, "SIGKILL");
  if (await waitForPidExit(pid, timeoutMs)) return { code: null, signal: "SIGKILL" };
  throw new OfficialProcessStopTimeoutError();
}

export function createDesktopSpawnedLoopbackBackend(input: {
  spawner: DesktopOfficialBackendSpawnerDescriptor;
  cwd?: string;
  stockCodexPath: string;
  arguments: readonly string[];
  environment: NodeJS.ProcessEnv;
  closeTimeoutMs?: number;
}): OwnedOfficialBackend {
  const closeTimeoutMs = input.closeTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const closed = Promise.withResolvers<OfficialAppServerExit>();
  let state: StartBackendResponse | undefined;
  let exitResult: OfficialAppServerExit | undefined;
  let waitRequest: ClientRequest | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let stopRequested = false;

  const settleExit = (exit: OfficialAppServerExit): void => {
    if (exitResult !== undefined) return;
    exitResult = exit;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    waitRequest?.destroy();
    waitRequest = undefined;
    closed.resolve(exit);
  };

  const watchDetachedPid = (pid: number): void => {
    if (!isProcessAlive(pid)) {
      settleExit({ code: 0, signal: null });
      return;
    }
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (!isProcessAlive(pid)) settleExit({ code: 0, signal: null });
    }, PID_POLL_INTERVAL_MS);
    pollTimer.unref();
  };

  const startWaitMonitor = (started: StartBackendResponse): void => {
    void loopbackHttpJson<ExitPayload>(
      input.spawner,
      "GET",
      `/v1/official-backend/wait?id=${encodeURIComponent(started.id)}`,
      undefined,
      (request) => {
        waitRequest = request;
      },
    ).then(
      (payload) => settleExit(fromExitPayload(payload)),
      (error: unknown) => {
        if (exitResult !== undefined || stopRequested) return;
        if (started.processId !== undefined) {
          watchDetachedPid(started.processId);
          return;
        }
        settleExit({
          code: 1,
          signal: null,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      },
    );
  };

  return {
    get processId() {
      return state?.processId;
    },
    closed: closed.promise,
    async start() {
      if (stopRequested) throw new Error("Shared official app-server is already closed");
      const started = await loopbackHttpJson<StartBackendResponse>(
        input.spawner,
        "POST",
        "/v1/official-backend/start",
        {
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          stockCodexPath: input.stockCodexPath,
          arguments: [...input.arguments],
          environment: input.environment,
        },
      );
      state = started;
      startWaitMonitor(started);
    },
    async connect() {
      if (!state || exitResult !== undefined || stopRequested) {
        throw new Error("Official listener is not ready");
      }
      return createRemoteOfficialAppServerConnection(state.endpoint, {
        capabilityToken: state.capabilityToken,
      });
    },
    async stop() {
      stopRequested = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      if (exitResult !== undefined) return;
      const started = state;
      if (!started) {
        settleExit({ code: 0, signal: null });
        return;
      }
      try {
        const result = await loopbackHttpJson<{ stopped: boolean; exit: ExitPayload }>(
          input.spawner,
          "POST",
          "/v1/official-backend/stop",
          { id: started.id },
        );
        settleExit(fromExitPayload(result.exit));
      } catch (error) {
        if (!(
          error instanceof DesktopOfficialSpawnerUnreachableError ||
          error instanceof DesktopOfficialBackendNotFoundError
        )) {
          throw error;
        }
        if (started.processId === undefined) {
          settleExit({ code: 0, signal: null });
          return;
        }
        const exit = await terminateDetachedPid(started.processId, closeTimeoutMs);
        settleExit(exit);
      }
    },
  };
}
