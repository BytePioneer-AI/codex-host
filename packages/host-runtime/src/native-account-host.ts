import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import {
  currentCodexAccountFromOfficialRead,
  SingleNativeCodexAccount,
  type CodexAccountControl,
} from "./account/codex-account-control.js";
import { officialEnvironment } from "./app-server-host.js";
import { OfficialRuntimeScope } from "./codex-runtime/official-runtime-scope.js";
import { createOwnedLoopbackBackend } from "./codex-runtime/owned-official-backends.js";
import { resolveOfficialCodexExecutable } from "./codex-runtime/command.js";
import {
  DESKTOP_CONTEXT_ENV,
  desktopBrowserMcpArguments,
  withoutDesktopContext,
} from "./desktop-context-environment.js";
import {
  assertCodexRuntimeFilesPresent,
  captureCodexRuntimeFiles,
  codexRuntimeFilesChanged,
  type CodexRuntimeFile,
} from "./codex-runtime/backend-files.js";
import { officialLoopbackListenerArguments } from "./remote-app-server.js";

interface NativeStartup {
  stockCodexPath: string;
  arguments: string[];
  environment: NodeJS.ProcessEnv;
}

export interface PreparedLocalCodex {
  officialRuntimeScope: OfficialRuntimeScope;
  accountControl: CodexAccountControl;
  /** Record Desktop's invocation and scope runtime context to its live attachment. */
  configureStartup(
    input: NativeStartup,
    attachment: AbortSignal,
    options?: { requireApplied?: boolean },
  ): Promise<void>;
  close(): Promise<void>;
}

export class OfficialStartupConflictError extends Error {
  constructor() {
    super("Shared Host already has an attached client with different Codex startup settings");
  }
}

function desktopContextChanged(current: NativeStartup, next: NativeStartup): boolean {
  return DESKTOP_CONTEXT_ENV.some((key) => current.environment[key] !== next.environment[key]);
}

function startupArgumentsKey(args: readonly string[]): string {
  try {
    return JSON.stringify(officialLoopbackListenerArguments(args));
  } catch {
    // Keep invalid invocations distinct so backend startup can report the error.
    return JSON.stringify(args);
  }
}

function startupChanged(current: NativeStartup, next: NativeStartup): boolean {
  return (
    current.stockCodexPath !== next.stockCodexPath ||
    startupArgumentsKey(current.arguments) !== startupArgumentsKey(next.arguments) ||
    desktopContextChanged(current, next)
  );
}

function withDesktopContext(startup: NativeStartup, desktop: NodeJS.ProcessEnv): NativeStartup {
  const environment = withoutDesktopContext(startup.environment);
  for (const key of DESKTOP_CONTEXT_ENV) {
    const value = desktop[key];
    if (value !== undefined) environment[key] = value;
  }
  return { ...startup, environment };
}

export async function canonicalCodexHome(home: string): Promise<string> {
  const absolute = path.resolve(home);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await canonicalCodexHome(parent), path.basename(absolute));
  }
}

export async function prepareLocalCodex(input: {
  stockCodexPath: string;
  arguments: string[];
  environment: NodeJS.ProcessEnv;
  diagnosticOutput: Writable;
  /** Shared service: Web-only use need not start the official Codex process. */
  deferStart?: boolean;
  /** Remote Control retains its supplied arguments and first-invocation-only configuration. */
  remoteControl?: boolean;
}): Promise<PreparedLocalCodex> {
  const home = await canonicalCodexHome(
    input.environment.CODEX_HOME ?? path.join(homedir(), ".codex"),
  );
  await mkdir(home, { recursive: true });
  const sharedDesktop = input.deferStart && !input.remoteControl;
  const startupFile =
    sharedDesktop && input.environment.CODEXHOST_DATA_DIR
      ? path.join(input.environment.CODEXHOST_DATA_DIR, "official-startup-v1.json")
      : undefined;
  let startup: NativeStartup = {
    stockCodexPath: input.stockCodexPath,
    arguments: sharedDesktop
      ? ["-c", "features.code_mode_host=true", "app-server"]
      : [...input.arguments],
    environment: input.deferStart ? withoutDesktopContext(input.environment) : input.environment,
  };
  if (startupFile) {
    try {
      const saved = JSON.parse(await readFile(startupFile, "utf8"));
      if (
        typeof saved.stockCodexPath === "string" &&
        path.isAbsolute(saved.stockCodexPath) &&
        Array.isArray(saved.arguments) &&
        saved.arguments.every((argument: unknown) => typeof argument === "string")
      ) {
        startup.stockCodexPath =
          input.stockCodexPath ||
          (await access(saved.stockCodexPath, constants.X_OK).then(
            () => saved.stockCodexPath,
            () => "",
          ));
        startup.arguments = saved.arguments;
      }
    } catch {
      // Missing or damaged startup records use the baseline invocation.
    }
  }
  startup.stockCodexPath =
    (await resolveOfficialCodexExecutable(startup.stockCodexPath, input.environment)) ?? "";
  const desktopStartups = new Map<AbortSignal, NativeStartup>();
  const nextStartup = () => {
    const attached = [...desktopStartups.values()].at(-1);
    if (!attached) return startup;
    // An older attachment can outlive a failed first launch and recovery.
    return input.remoteControl ? withDesktopContext(startup, attached.environment) : attached;
  };
  let startupQueue = Promise.resolve();
  let running: NativeStartup | undefined;
  let startupConfigured = false;
  let backendFiles: CodexRuntimeFile[] = [];
  const scope = new OfficialRuntimeScope({
    permanentHome: home,
    diagnosticOutput: input.diagnosticOutput,
    // Local Desktop connections outlive a failed official backend generation.
    recovery: {},
    shouldReplaceIdleBackend: () =>
      running !== undefined &&
      ((input.deferStart && startupChanged(running, nextStartup())) ||
        codexRuntimeFilesChanged(backendFiles)),
    createBackend: () => {
      try {
        const configuration = nextStartup();
        if (!configuration.stockCodexPath) throw new Error("Official Codex is unavailable");
        backendFiles = captureCodexRuntimeFiles(configuration.stockCodexPath);
        running = configuration;
        const backend = createOwnedLoopbackBackend({
          stockCodexPath: configuration.stockCodexPath,
          cwd: home,
          arguments: [
            ...configuration.arguments,
            ...desktopBrowserMcpArguments(configuration.environment),
          ],
          environment: { ...officialEnvironment(configuration.environment), CODEX_HOME: home },
        });
        startupConfigured = true;
        // Before the first successful start, a failed backend may release this provisional choice.
        void backend.closed.then(() => {
          startupConfigured = false;
        });
        return backend;
      } catch (error) {
        startupConfigured = false;
        throw error;
      }
    },
  });
  // controlRequest requires an initialized client on this same owned backend.
  // This connection only reads native identity; it does not own authentication.
  const identityReader = scope.owner.attachManagement(async () => {});
  identityReader.configure({
    clientInfo: { name: "codexhost_identity_reader", version: "1" },
    capabilities: { experimentalApi: true },
  });
  try {
    if (!input.deferStart) await scope.start();
  } catch (error) {
    await scope.close();
    identityReader.close();
    throw error;
  }
  let current: ReturnType<typeof currentCodexAccountFromOfficialRead> = null;
  const snapshot = () => ({
    version: 2 as const,
    currentAccountId: current?.accountId ?? null,
    phase: scope.gate.phase,
    revision: scope.gate.revision,
    accounts: current ? [current] : [],
  });
  const accounts = new SingleNativeCodexAccount(snapshot, async () => {
    await scope.start();
    const response = await scope.owner.controlRequest("account/read", { refreshToken: false });
    if (response.error) throw new Error("Official Account read failed");
    current = currentCodexAccountFromOfficialRead(response.result);
    return snapshot();
  });
  const remoteInvocationFixed = () =>
    input.remoteControl && (startupConfigured || scope.owner.hasStartedSuccessfully);

  async function applyStartup(
    configuration: NativeStartup,
    attachment: AbortSignal,
    requireApplied?: boolean,
  ) {
    if (!input.deferStart || scope.closed || attachment.aborted) return;
    let next = startup;
    if (!remoteInvocationFixed()) {
      const stockCodexPath = await resolveOfficialCodexExecutable(
        configuration.stockCodexPath,
        configuration.environment,
      );
      if (scope.closed || attachment.aborted) return;
      if (!remoteInvocationFixed()) {
        if (!stockCodexPath) throw new Error("Official Codex executable is a shim or proxy");
        next = { ...configuration, stockCodexPath, arguments: [...configuration.arguments] };
      }
    }
    if (input.remoteControl) {
      // The listener pins the native invocation; runtime context belongs to each attached Desktop.
      next = withDesktopContext(next, configuration.environment);
      startupConfigured = true;
    }
    if (!requireApplied && startupFile) {
      try {
        await mkdir(path.dirname(startupFile), { recursive: true });
        await writeFile(
          startupFile,
          JSON.stringify({
            stockCodexPath: next.stockCodexPath,
            arguments: next.arguments,
          }),
          { mode: 0o600 },
        );
      } catch {
        input.diagnosticOutput.write(
          "codexhost: could not record official Codex startup arguments\n",
        );
      }
    }
    if (scope.closed || attachment.aborted) return;
    const owner = scope.owner;
    const current = owner.running && running ? running : nextStartup();
    const changed =
      startupChanged(current, next) || (owner.running && codexRuntimeFilesChanged(backendFiles));
    const active = owner.hasActiveWork;
    // The running generation owns the files it started with.
    if (owner.running && (!changed || active)) assertCodexRuntimeFilesPresent(backendFiles);
    if (requireApplied) {
      for (const [peer, configured] of desktopStartups) {
        if (peer !== attachment && startupChanged(configured, next))
          throw new OfficialStartupConflictError();
      }
      if (changed && active) throw new Error("Official Codex startup is waiting for active work");
    }
    // SSH settings belong to the connected peer. Desktop settings are also remembered for Web.
    if (!requireApplied)
      startup = { ...next, environment: withoutDesktopContext(next.environment) };
    if (desktopStartups.has(attachment)) desktopStartups.delete(attachment);
    else {
      attachment.addEventListener("abort", () => desktopStartups.delete(attachment), {
        once: true,
      });
    }
    desktopStartups.set(attachment, next);
    if (!changed || owner.generation === 0) return;
    if (active) {
      input.diagnosticOutput.write(
        "codexhost: Desktop startup differs; preserving active official Codex work\n",
      );
      return;
    }
    await scope.stop();
  }
  return {
    officialRuntimeScope: scope,
    accountControl: accounts,
    configureStartup: (configuration, attachment, options) => {
      const configured = startupQueue.then(() =>
        applyStartup(configuration, attachment, options?.requireApplied),
      );
      startupQueue = configured.catch(() => undefined);
      return configured;
    },
    close: async () => {
      desktopStartups.clear();
      await scope.close();
      identityReader.close();
    },
  };
}
