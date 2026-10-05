import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";

import {
  currentCodexAccountFromOfficialRead,
  SingleNativeCodexAccount,
  type CodexAccountControl,
} from "./account/codex-account-control.js";
import { officialLoopbackListenerArguments } from "./remote-app-server.js";
import { officialEnvironment } from "./app-server-host.js";
import { OfficialRuntimeScope } from "./codex-runtime/official-runtime-scope.js";
import { createOwnedLoopbackBackend } from "./codex-runtime/owned-official-backends.js";

export interface DaemonRuntimeAttach {
  stockCodexPath: string;
  arguments: string[];
  defaultAgent: "codex" | "pi";
}

export interface DaemonOfficialRuntime {
  scope: OfficialRuntimeScope;
  accountControl: CodexAccountControl;
  attach(input: DaemonRuntimeAttach): Promise<void>;
  close(): Promise<void>;
}

export async function createDaemonOfficialRuntime(input: {
  environment: NodeJS.ProcessEnv;
  diagnosticOutput: Writable;
}): Promise<DaemonOfficialRuntime> {
  const home = path.resolve(input.environment.CODEX_HOME ?? path.join(homedir(), ".codex"));
  await mkdir(home, { recursive: true });

  let configuration: DaemonRuntimeAttach | null = null;
  const scope = new OfficialRuntimeScope({
    permanentHome: home,
    diagnosticOutput: input.diagnosticOutput,
    recovery: {},
    createBackend: () => {
      if (!configuration) throw new Error("Codex Desktop has not attached to the daemon");
      return createOwnedLoopbackBackend({
        stockCodexPath: configuration.stockCodexPath,
        cwd: home,
        arguments: configuration.arguments,
        environment: { ...officialEnvironment(input.environment), CODEX_HOME: home },
      });
    },
  });

  const identityReader = scope.owner.attachManagement(async () => {});
  identityReader.configure({
    clientInfo: { name: "codexhost_daemon_identity_reader", version: "1" },
    capabilities: { experimentalApi: true },
  });
  let current: ReturnType<typeof currentCodexAccountFromOfficialRead> = null;
  const snapshot = () => ({
    version: 2 as const,
    currentAccountId: current?.accountId ?? null,
    phase: scope.gate.phase,
    revision: scope.gate.revision,
    accounts: current ? [current] : [],
  });
  const accountControl = new SingleNativeCodexAccount(snapshot, async () => {
    const response = await scope.owner.controlRequest("account/read", { refreshToken: false });
    if (response.error) throw new Error("Official Account read failed");
    current = currentCodexAccountFromOfficialRead(response.result);
    return snapshot();
  });

  return {
    scope,
    accountControl,
    async attach(next) {
      if (!path.isAbsolute(next.stockCodexPath))
        throw new Error("Official Codex path must be absolute");
      const normalized = {
        ...next,
        stockCodexPath: path.normalize(next.stockCodexPath),
        arguments: officialLoopbackListenerArguments(next.arguments),
      };
      if (
        configuration &&
        (configuration.stockCodexPath !== normalized.stockCodexPath ||
          JSON.stringify(configuration.arguments) !== JSON.stringify(normalized.arguments))
      ) {
        if (scope.owner.running) {
          if (scope.gate.busy) {
            throw new Error(
              "Official Codex invocation changed while Codex is busy; retry when idle",
            );
          }
          // Desktop's startup probe and main client can supply different native
          // plugin overrides. Replace only the idle Official generation; the
          // daemon and its external Harness sessions keep their ownership.
          await scope.owner.stop();
        }
      }
      configuration = normalized;
    },
    async close() {
      identityReader.close();
      await scope.close();
    },
  };
}
