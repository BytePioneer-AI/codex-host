import type { IncomingMessage } from "node:http";
import path from "node:path";
import type { Writable } from "node:stream";
import {
  discoverHostClientChannel,
  ensureHostService,
  type HostServiceLaunch,
} from "@codexhost/desktop-control";
import type { OwnedOfficialBackend } from "./codex-runtime/official-runtime-owner.js";
import {
  canonicalCodexHome,
  OfficialStartupConflictError,
  type PreparedLocalCodex,
} from "./native-account-host.js";
import type {
  OfficialAppServerConnection,
  OfficialAppServerExit,
} from "./official-app-server-connection.js";
import type { RemoteAppServerSession, RemoteAppServerSessionStreams } from "./remote-app-server.js";
import { officialLoopbackListenerArguments } from "./remote-app-server.js";
import {
  createRemoteOfficialAppServerConnection,
  OfficialAppServerHandshakeError,
} from "./remote-official-connection.js";

export const SHARED_OFFICIAL_PATH = "/v1/official";
export const OFFICIAL_CODEX_HOME_HEADER = "x-codexhost-codex-home";
const OFFICIAL_STARTUP_HEADER = "x-codexhost-official-startup";
const SHARED_OFFICIAL_HANDSHAKE_TIMEOUT_MS = 15_000;

export interface SharedOfficialUpgradeHandler {
  prepare(
    request: IncomingMessage,
    attachment: AbortSignal,
  ): Promise<
    | {
        ok: true;
        attach(streams: RemoteAppServerSessionStreams): RemoteAppServerSession;
        abort(): void;
      }
    | { ok: false; status: 400 | 409 | 412 | 503; message: string }
  >;
}

function createOfficialProxySession(
  connection: OfficialAppServerConnection,
  streams: RemoteAppServerSessionStreams,
  release: () => void,
): RemoteAppServerSession {
  let exitCode: number | undefined;
  const finish = (code: number): number => {
    if (exitCode !== undefined) return exitCode;
    exitCode = code;
    streams.input.unpipe(connection.stdin);
    connection.stdout.unpipe(streams.output);
    release();
    return code;
  };
  const detach = (): void => {
    if (exitCode !== undefined) return;
    finish(0);
    connection.close();
  };
  connection.stdin.on("error", () => undefined);
  connection.stdout.on("error", () => undefined);
  connection.stderr.resume();
  return {
    run: () => {
      streams.input.on("end", detach);
      streams.input.on("close", detach);
      streams.input.on("error", detach);
      streams.input.pipe(connection.stdin);
      // Leave streams.output open so attachRemoteAppServerSession can send a 1011
      // close frame on backend-initiated exit before ending output in finally.
      connection.stdout.pipe(streams.output, { end: false });
      return connection.closed.then(() => finish(1));
    },
    disconnect: detach,
    close: detach,
  };
}

/**
 * Exposes the Shared Host's single official Codex app-server process to local
 * authenticated peers (such as the SSH listener) so both share one CODEX_HOME
 * writer owner instead of spawning competing app-server processes.
 */
export function createSharedOfficialSessionHandler(
  official: PreparedLocalCodex,
  isStopping: () => boolean = () => false,
  startup?: { stockCodexPath: string; environment: NodeJS.ProcessEnv },
): SharedOfficialUpgradeHandler {
  return {
    async prepare(request, attachment) {
      if (isStopping()) return { ok: false, status: 503, message: "Shared Host is stopping" };
      const scope = official.officialRuntimeScope;
      const homeHeader = request.headers[OFFICIAL_CODEX_HOME_HEADER];
      if (homeHeader !== undefined) {
        const requestedHome =
          typeof homeHeader === "string" && homeHeader.length <= 8192
            ? Buffer.from(homeHeader, "base64").toString("utf8")
            : "";
        if (!path.isAbsolute(requestedHome))
          return { ok: false, status: 400, message: "Invalid official Codex home header" };
        const [canonicalRequested, canonicalOwned] = await Promise.all([
          canonicalCodexHome(requestedHome).catch(() => null),
          canonicalCodexHome(scope.permanentHome).catch(() => null),
        ]);
        if (canonicalRequested === null || canonicalOwned === null) {
          return { ok: false, status: 503, message: "Official Codex home could not be verified" };
        }
        if (canonicalRequested !== canonicalOwned) {
          return { ok: false, status: 409, message: "Official Codex home mismatch" };
        }
      }
      const rawArguments = request.headers[OFFICIAL_STARTUP_HEADER];
      let args: string[] | undefined;
      if (rawArguments !== undefined) {
        try {
          if (!startup || typeof rawArguments !== "string" || rawArguments.length > 12_000)
            throw new Error("Invalid native startup arguments");
          const parsed: unknown = JSON.parse(Buffer.from(rawArguments, "base64").toString("utf8"));
          if (!Array.isArray(parsed) || !parsed.every((argument) => typeof argument === "string"))
            throw new Error("Invalid native startup arguments");
          args = officialLoopbackListenerArguments(parsed);
        } catch {
          return { ok: false, status: 400, message: "Invalid official startup header" };
        }
      }
      const startupAttachment = new AbortController();
      const signal = AbortSignal.any([attachment, startupAttachment.signal]);
      const release = () => startupAttachment.abort();
      let attached = false;
      try {
        signal.throwIfAborted();
        if (args && startup)
          await official.configureStartup({ ...startup, arguments: args }, signal, {
            requireApplied: true,
          });
        signal.throwIfAborted();
        await scope.refreshBeforeRequest();
        if (isStopping()) return { ok: false, status: 503, message: "Shared Host is stopping" };
        await scope.start();
        if (isStopping()) return { ok: false, status: 503, message: "Shared Host is stopping" };
        const connection = await scope.owner.connectProxy();
        if (isStopping() || signal.aborted) {
          connection.close();
          return { ok: false, status: 503, message: "Shared Host is stopping" };
        }
        attached = true;
        return {
          ok: true,
          attach: (streams) => createOfficialProxySession(connection, streams, release),
          abort: () => {
            connection.close();
            release();
          },
        };
      } catch (error) {
        if (error instanceof OfficialStartupConflictError)
          return { ok: false, status: 412, message: error.message };
        return { ok: false, status: 503, message: "Official Codex is unavailable" };
      } finally {
        if (!attached) release();
      }
    },
  };
}

/**
 * Connects an SSH listener's OfficialRuntimeScope to the Shared Host's single
 * official app-server process when available and matching CODEX_HOME, falling
 * back to a dedicated local official app-server only for a different home.
 */
export function createSharedOfficialBackend(input: {
  launch: HostServiceLaunch;
  codexHome: string;
  startupArguments?: readonly string[];
  fallback: () => OwnedOfficialBackend;
  diagnosticOutput: Writable;
  ensureHostService?: typeof ensureHostService;
}): OwnedOfficialBackend {
  const ensure = input.ensureHostService ?? ensureHostService;
  const closed = Promise.withResolvers<OfficialAppServerExit>();
  let stopped = false;
  let delegate: OwnedOfficialBackend | undefined;
  type SharedHost = {
    descriptor: NonNullable<Awaited<ReturnType<typeof discoverHostClientChannel>>>;
    headers: Record<string, string>;
  };
  let shared: SharedHost | undefined;
  const connections = new Set<OfficialAppServerConnection>();

  const closeShared = () => {
    shared = undefined;
    return Promise.allSettled(
      [...connections].map((connection) => {
        connection.close();
        return connection.closed;
      }),
    );
  };

  const dial = (target: SharedHost, headers = target.headers) =>
    createRemoteOfficialAppServerConnection(
      `ws://127.0.0.1:${target.descriptor.port}${SHARED_OFFICIAL_PATH}`,
      {
        capabilityToken: target.descriptor.token,
        headers,
        handshakeTimeoutMs: SHARED_OFFICIAL_HANDSHAKE_TIMEOUT_MS,
      },
    );

  const trackConnection = (connection: OfficialAppServerConnection, onClose?: () => void) => {
    connections.add(connection);
    void connection.closed.then(() => {
      connections.delete(connection);
      onClose?.();
    });
    return connection;
  };

  return {
    get processId() {
      return delegate?.processId;
    },
    get isolatesConnectionFailures() {
      return delegate === undefined;
    },
    closed: closed.promise,
    async start() {
      if (stopped) throw new Error("Shared official backend is already closed");
      const { launch, codexHome, startupArguments } = input;
      const canonicalHome = await canonicalCodexHome(codexHome);
      await ensure(launch);
      const descriptor = await discoverHostClientChannel(
        path.join(launch.dataDirectory, "client-hosts"),
      );
      if (descriptor?.owner !== "service") throw new Error("Independent Host is unavailable");
      const target = {
        descriptor,
        headers: { [OFFICIAL_CODEX_HOME_HEADER]: Buffer.from(canonicalHome).toString("base64") },
      };
      const headers: Record<string, string> = { ...target.headers };
      if (startupArguments)
        headers[OFFICIAL_STARTUP_HEADER] = Buffer.from(JSON.stringify(startupArguments)).toString(
          "base64",
        );
      try {
        const connection = await dial(target, headers);
        if (stopped) {
          connection.close();
          throw new Error("Shared official backend is already closed");
        }
        shared = target;
        // The startup attachment represents the generation for all viewers.
        connection.stdout.resume();
        trackConnection(connection, () => {
          if (shared !== target) return;
          void closeShared();
          closed.resolve({
            code: 1,
            signal: null,
            error: new Error("Shared official app-server generation ended"),
          });
        });
        return;
      } catch (error) {
        if (stopped || !(error instanceof OfficialAppServerHandshakeError)) throw error;
        switch (error.status) {
          case 401: {
            const message =
              "Shared Host official proxy is unavailable; verify the Shared Host version";
            input.diagnosticOutput.write(`codexhost: ${message}\n`);
            throw new Error(message, { cause: error });
          }
          case 412: {
            const conflict = new OfficialStartupConflictError();
            input.diagnosticOutput.write(`codexhost: ${conflict.message}\n`);
            throw conflict;
          }
          case 409:
            input.diagnosticOutput.write(
              `codexhost: shared official app-server unavailable (${error.message}); falling back to local SSH official app-server\n`,
            );
            break;
          default:
            throw error;
        }
      }
      const fallbackBackend = input.fallback();
      delegate = fallbackBackend;
      void fallbackBackend.closed.then(closed.resolve);
      await fallbackBackend.start();
    },
    async connect() {
      if (delegate) return delegate.connect();
      const target = shared;
      if (!target) throw new Error("Official listener is not ready");
      const connection = await dial(target);
      if (shared !== target) {
        connection.close();
        throw new Error("Shared official app-server generation ended during connection");
      }
      return trackConnection(connection);
    },
    async stop() {
      stopped = true;
      if (delegate) {
        await delegate.stop();
        return;
      }
      await closeShared();
      closed.resolve({ code: 0, signal: null });
    },
  };
}
