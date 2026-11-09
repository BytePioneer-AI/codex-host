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

export interface PreparedLocalCodex {
  officialRuntimeScope: OfficialRuntimeScope;
  accountControl: CodexAccountControl;
  /** Record Desktop's invocation and retire a differently configured idle backend. */
  configureStartup(input: {
    stockCodexPath: string;
    arguments: string[];
    environment: NodeJS.ProcessEnv;
  }): Promise<void>;
  close(): Promise<void>;
}

async function canonicalCodexHome(home: string): Promise<string> {
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
  const startupFile =
    input.deferStart && !input.remoteControl && input.environment.CODEXHOST_DATA_DIR
      ? path.join(input.environment.CODEXHOST_DATA_DIR, "official-startup-v1.json")
      : undefined;
  let startup = {
    stockCodexPath: input.stockCodexPath,
    arguments:
      input.deferStart && !input.remoteControl
        ? ["-c", "features.code_mode_host=true", "app-server"]
        : [...input.arguments],
    environment: input.environment,
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
  let startupConfigured = false;
  const scope = new OfficialRuntimeScope({
    permanentHome: home,
    diagnosticOutput: input.diagnosticOutput,
    // Local Desktop connections outlive a failed official backend generation.
    recovery: {},
    createBackend: () => {
      startupConfigured = true;
      if (!startup.stockCodexPath) throw new Error("Official Codex is unavailable");
      return createOwnedLoopbackBackend({
        stockCodexPath: startup.stockCodexPath,
        cwd: home,
        arguments: startup.arguments,
        environment: { ...officialEnvironment(startup.environment), CODEX_HOME: home },
      });
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
  return {
    officialRuntimeScope: scope,
    accountControl: accounts,
    configureStartup: async (configuration) => {
      if (!input.deferStart || scope.closed || (input.remoteControl && startupConfigured)) return;
      const stockCodexPath = await resolveOfficialCodexExecutable(
        configuration.stockCodexPath,
        configuration.environment,
      );
      if (!stockCodexPath) throw new Error("Official Codex executable is a shim or proxy");
      const next = { ...configuration, stockCodexPath, arguments: [...configuration.arguments] };
      if (input.remoteControl) {
        startupConfigured = true;
        startup = next;
        return;
      }
      if (startupFile) {
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
      const changed =
        startup.stockCodexPath !== next.stockCodexPath ||
        JSON.stringify(startup.arguments) !== JSON.stringify(next.arguments);
      if (changed && scope.owner.generation > 0 && scope.owner.hasActiveWork) {
        input.diagnosticOutput.write(
          "codexhost: Desktop startup differs; preserving active official Codex work\n",
        );
        return;
      }
      startup = next;
      if (changed && scope.owner.generation > 0) await scope.stop();
    },
    close: async () => {
      await scope.close();
      identityReader.close();
    },
  };
}
