import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { ExternalHarnessId } from "@codexhost/protocol-core";

import { AppServerHost } from "./app-server-host.js";
import { startDelegationControlServer } from "./delegation-control-server.js";
import {
  DELEGATION_CLI_PATH_ENV,
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
  DelegationControlError,
  type DelegationControlApi,
  type DelegationControlRegistration,
} from "./delegation-types.js";
import { installedHarnessPluginOptions } from "./installed-harness-plugins.js";
import type { OfficialAppServerConnection } from "./official-app-server-connection.js";

const READY_TIMEOUT_MS = 30_000;
const PLACEHOLDER_PARENT = "00000000-0000-4000-8000-000000000001";

export type IsolatedDelegationMode = "hermetic" | "live";

export interface IsolatedDelegationRuntimeOptions {
  dataDirectory: string;
  cliPath: string;
  mode: IsolatedDelegationMode;
  environment?: NodeJS.ProcessEnv;
  externalAdapters?: ReadonlyMap<ExternalHarnessId, HarnessAdapter>;
  pluginRoots?: readonly string[];
  expectedHarnessId?: string;
}

export interface IsolatedDelegationRuntime {
  readonly mode: IsolatedDelegationMode;
  readonly endpoint: string;
  readonly dataDirectory: string;
  readonly pid: number;
  readonly cliPath: string;
  readonly officialKind: "fixture";
  childEnvironment(): NodeJS.ProcessEnv;
  close(): Promise<{ cleanupErrors: string[] }>;
}

/** Official Codex is a labeled fixture: it never issues model inference. */
export function createFixtureOfficialConnection(): OfficialAppServerConnection {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closed = Promise.withResolvers<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>();
  let closedOnce = false;
  const finish = () => {
    if (closedOnce) return;
    closedOnce = true;
    if (!stdin.destroyed) stdin.end();
    if (!stdout.destroyed) stdout.end();
    if (!stderr.destroyed) stderr.end();
    closed.resolve({ code: 0, signal: null });
  };
  return {
    stdin,
    stdout,
    stderr,
    closed: closed.promise,
    close: finish,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Strip inherited Desktop/Host control coordinates so an isolated run cannot
 * accidentally target the caller's live Runtime.
 */
export function isolatedDelegationEnvironment(
  source: NodeJS.ProcessEnv,
  overlay: {
    dataDirectory: string;
    endpoint: string;
    token: string;
    cliPath: string;
  },
): NodeJS.ProcessEnv {
  const {
    [DELEGATION_RUNTIME_ENDPOINT_ENV]: _inheritedEndpoint,
    [DELEGATION_RUNTIME_TOKEN_ENV]: _inheritedToken,
    CODEXHOST_CONTROL_PORT: _controlPort,
    CODEXHOST_CONTROL_NONCE: _controlNonce,
    ...rest
  } = source;
  void _inheritedEndpoint;
  void _inheritedToken;
  void _controlPort;
  void _controlNonce;
  const environment: NodeJS.ProcessEnv = { ...rest };
  environment.CODEXHOST_DATA_DIR = overlay.dataDirectory;
  environment[DELEGATION_RUNTIME_ENDPOINT_ENV] = overlay.endpoint;
  environment[DELEGATION_RUNTIME_TOKEN_ENV] = overlay.token;
  environment[DELEGATION_CLI_PATH_ENV] = overlay.cliPath;
  environment.CODEXHOST_STOCK_CODEX_PATH =
    environment.CODEXHOST_STOCK_CODEX_PATH ?? "/synthetic/codex";
  environment.CODEXHOST_DEFAULT_AGENT = environment.CODEXHOST_DEFAULT_AGENT ?? "codex";
  return environment;
}

async function waitUntilControlReady(
  api: DelegationControlApi,
  harnessId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await api.inspect({ harnessId });
      await api.list({
        parentThreadId: PLACEHOLDER_PARENT,
        limit: 1,
        sort: "created-desc",
      });
      return;
    } catch (error) {
      lastError = error;
      const code = error instanceof DelegationControlError ? error.code : undefined;
      const message = errorMessage(error);
      const retryable =
        code === "HARNESS_NOT_FOUND" ||
        message.includes("STORE_NOT_INITIALIZED") ||
        message.includes("not initialized");
      if (!retryable) throw error;
    }
    await delay(25);
  }
  throw new Error(
    `Isolated Host control plane was not ready within ${timeoutMs}ms: ${errorMessage(lastError)}`,
  );
}

export async function startIsolatedDelegationRuntime(
  options: IsolatedDelegationRuntimeOptions,
): Promise<IsolatedDelegationRuntime> {
  if (options.mode === "hermetic" && !options.externalAdapters) {
    throw new Error("Hermetic isolated Runtime requires injected Harness Adapters");
  }
  if (options.mode === "live" && options.externalAdapters) {
    throw new Error("Live isolated Runtime must use production plugins, not injected Adapters");
  }

  const dataDirectory = path.resolve(options.dataDirectory);
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const expectedHarnessId = options.expectedHarnessId ?? "grok";

  let registration: DelegationControlRegistration | undefined;
  const server = await startDelegationControlServer({
    token,
    api: {
      inspect: (input) => {
        if (!registration) throw new Error("Isolated Host Delegation API is not registered");
        return registration.inspect(input);
      },
      start: (input) => {
        if (!registration) throw new Error("Isolated Host Delegation API is not registered");
        return registration.start(input);
      },
      send: (input) => {
        if (!registration) throw new Error("Isolated Host Delegation API is not registered");
        return registration.send(input);
      },
      cancel: (input) => {
        if (!registration) throw new Error("Isolated Host Delegation API is not registered");
        return registration.cancel(input);
      },
      read: (input) => {
        if (!registration) throw new Error("Isolated Host Delegation API is not registered");
        return registration.read(input);
      },
      wait: (input) => {
        if (!registration) throw new Error("Isolated Host Delegation API is not registered");
        return registration.wait(input);
      },
      list: (input) => {
        if (!registration) throw new Error("Isolated Host Delegation API is not registered");
        return registration.list(input);
      },
      status: (input) => {
        if (!registration) throw new Error("Isolated Host Delegation API is not registered");
        if (!registration.status) {
          throw new DelegationControlError("INVALID_ARGUMENT", "Thread status is unavailable");
        }
        return registration.status(input);
      },
      waitMany: (input) => {
        if (!registration) throw new Error("Isolated Host Delegation API is not registered");
        if (!registration.waitMany) {
          throw new DelegationControlError("INVALID_ARGUMENT", "wait-many is unavailable");
        }
        return registration.waitMany(input);
      },
      evidence: (input) => {
        if (!registration) throw new Error("Isolated Host Delegation API is not registered");
        if (!registration.evidence) {
          throw new DelegationControlError("INVALID_ARGUMENT", "Thread evidence is unavailable");
        }
        return registration.evidence(input);
      },
      configuration: (input) => {
        if (!registration) throw new Error("Isolated Host Delegation API is not registered");
        if (!registration.configuration) {
          throw new DelegationControlError(
            "INVALID_ARGUMENT",
            "Thread configuration is unavailable",
          );
        }
        return registration.configuration(input);
      },
      release: (input) => {
        if (!registration) throw new Error("Isolated Host Delegation API is not registered");
        if (!registration.release) {
          throw new DelegationControlError("INVALID_ARGUMENT", "Thread release is unavailable");
        }
        return registration.release(input);
      },
      reconcile: (input) => {
        if (!registration) throw new Error("Isolated Host Delegation API is not registered");
        if (!registration.reconcile) {
          throw new DelegationControlError(
            "INVALID_ARGUMENT",
            "Delegation reconcile is unavailable",
          );
        }
        return registration.reconcile(input);
      },
    },
  });

  const environment = isolatedDelegationEnvironment(options.environment ?? process.env, {
    dataDirectory,
    endpoint: server.endpoint,
    token,
    cliPath: options.cliPath,
  });
  const pluginOptions =
    options.mode === "live" ? installedHarnessPluginOptions(environment, false) : undefined;
  const desktopInput = new PassThrough();
  const desktopOutput = new PassThrough();
  const diagnosticOutput = new PassThrough();
  diagnosticOutput.resume();
  desktopOutput.resume();

  const host = new AppServerHost({
    stockCodexPath: environment.CODEXHOST_STOCK_CODEX_PATH ?? "/synthetic/codex",
    arguments: ["app-server"],
    defaultAgent: "codex",
    environment,
    desktopInput,
    desktopOutput,
    diagnosticOutput,
    runtimeEpoch: randomUUID(),
    ...(options.externalAdapters ? { externalAdapters: options.externalAdapters } : {}),
    ...(options.pluginRoots
      ? { pluginRoots: options.pluginRoots }
      : pluginOptions
        ? { pluginRoots: pluginOptions.pluginRoots, pluginContext: pluginOptions.pluginContext }
        : {}),
    createOfficialConnection: () => createFixtureOfficialConnection(),
    onDelegationApi: (api) => {
      registration = api;
      return () => {
        registration = undefined;
      };
    },
  });

  let started = false;
  const running = host.run().then((code) => {
    if (!started) {
      throw new Error(`Isolated Host exited during startup with code ${code}`);
    }
    return code;
  });

  try {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!registration) {
      if (Date.now() > deadline) throw new Error("Isolated Host did not register Delegation API");
      await Promise.race([delay(10), running]);
    }
    await waitUntilControlReady(registration, expectedHarnessId, READY_TIMEOUT_MS);
    started = true;
  } catch (error) {
    host.close();
    await Promise.allSettled([running, server.close()]);
    throw error;
  }

  let closed = false;
  return {
    mode: options.mode,
    endpoint: server.endpoint,
    dataDirectory,
    pid: process.pid,
    cliPath: options.cliPath,
    officialKind: "fixture",
    childEnvironment() {
      return isolatedDelegationEnvironment(environment, {
        dataDirectory,
        endpoint: server.endpoint,
        token,
        cliPath: options.cliPath,
      });
    },
    async close() {
      if (closed) return { cleanupErrors: [] };
      closed = true;
      const cleanupErrors: string[] = [];
      started = true;
      try {
        host.close();
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
      try {
        await Promise.race([
          running,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Isolated Host run() did not exit")), 8_000),
          ),
        ]);
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
      try {
        await server.close();
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
      return { cleanupErrors };
    },
  };
}

export function isolatedRuntimeTempDirectory(prefix = "codexhost-isolated-delegation-"): string {
  return path.join(os.tmpdir(), `${prefix}${process.pid}-${Date.now()}`);
}
