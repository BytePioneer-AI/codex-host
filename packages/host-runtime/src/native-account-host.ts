import { mkdir, realpath } from "node:fs/promises";
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

export interface PreparedLocalCodex {
  officialRuntimeScope: OfficialRuntimeScope;
  accountControl: CodexAccountControl;
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
}): Promise<PreparedLocalCodex> {
  const home = await canonicalCodexHome(
    input.environment.CODEX_HOME ?? path.join(homedir(), ".codex"),
  );
  await mkdir(home, { recursive: true });
  const scope = new OfficialRuntimeScope({
    permanentHome: home,
    diagnosticOutput: input.diagnosticOutput,
    // Local Desktop connections outlive a failed official backend generation.
    recovery: {},
    createBackend: () =>
      createOwnedLoopbackBackend({
        stockCodexPath: input.stockCodexPath,
        cwd: home,
        arguments: input.arguments,
        environment: { ...officialEnvironment(input.environment), CODEX_HOME: home },
      }),
  });
  // controlRequest requires an initialized client on this same owned backend.
  // This connection only reads native identity; it does not own authentication.
  const identityReader = scope.owner.attachManagement(async () => {});
  identityReader.configure({
    clientInfo: { name: "codexhost_identity_reader", version: "1" },
    capabilities: { experimentalApi: true },
  });
  try {
    await scope.start();
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
    const response = await scope.owner.controlRequest("account/read", { refreshToken: false });
    if (response.error) throw new Error("Official Account read failed");
    current = currentCodexAccountFromOfficialRead(response.result);
    return snapshot();
  });
  void accounts.refresh?.()?.catch(() => {
    input.diagnosticOutput.write("codexhost: Codex Account identity could not be read\n");
  });
  return {
    officialRuntimeScope: scope,
    accountControl: accounts,
    close: async () => {
      await scope.close();
      identityReader.close();
    },
  };
}
