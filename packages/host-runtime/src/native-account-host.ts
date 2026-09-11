import { createHash, randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type {
  CodexAccountControl,
  UnavailableCodexAccountReason,
} from "./account/codex-account-control.js";
import {
  SingleNativeCodexAccount,
  UnavailableCodexAccounts,
} from "./account/codex-account-control.js";
import { canonicalCodexHome, inspectNativeAccountLayout } from "./account/native-account-layout.js";
import { NativeAccountStore } from "./account/native-account-store.js";
import { NativeCodexAccounts } from "./account/native-codex-accounts.js";
import { OfficialAccountRuntime } from "./account/official-account-runtime.js";
import { officialEnvironment } from "./app-server-host.js";
import { readOfficialCliVersion } from "./codex-runtime/official-cli-version.js";
import { OfficialProcessRecord } from "./codex-runtime/official-process-record.js";
import {
  OfficialRuntimeScope,
  createOwnedConnectionBackend,
} from "./codex-runtime/official-runtime-scope.js";
import {
  createOwnedLoopbackBackend,
  createOwnedStdioBackend,
} from "./codex-runtime/owned-official-backends.js";
import type { OwnedOfficialBackend } from "./codex-runtime/official-runtime-owner.js";
import { NativePrivateFiles } from "./native-private-files.js";
import { NativeSecretKeys } from "./native-secret-keys.js";
import { readNativeProcessIdentity } from "./native-process-identity.js";
import { readNativeProcessIds } from "./native-process-inventory.js";
import { spawnOfficialAppServerConnection } from "./official-app-server-connection.js";
import { officialLoopbackListenerArguments } from "./remote-app-server.js";
import { createLoopbackOfficialAppServerListener } from "./remote-official-app-server.js";
import { createRemoteOfficialAppServerConnection } from "./remote-official-connection.js";

export interface PreparedLocalCodex {
  officialRuntimeScope: OfficialRuntimeScope;
  accountControl: CodexAccountControl;
  allowNativeAuthPassthrough: boolean;
  close(): Promise<void>;
}
interface LocalCodexOptions {
  stockCodexPath: string;
  arguments: string[];
  environment: NodeJS.ProcessEnv;
  sharedListener: boolean;
  diagnosticOutput: Writable;
}
const discardNativeDiagnostics = (): Writable =>
  new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
function stagingEnvironment(source: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const allowed = new Set([
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "WINDIR",
    "PATH",
    "TMP",
    "TEMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(([name]) => allowed.has(name.toUpperCase())),
    ),
    CODEX_HOME: home,
  };
}
async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
function blocked(
  home: string,
  output: Writable,
  reason: UnavailableCodexAccountReason,
): PreparedLocalCodex {
  output.write(`codexhost: Codex Account startup blocked (${reason})\n`);
  const scope = new OfficialRuntimeScope({
    permanentHome: home,
    diagnosticOutput: output,
    managedAccounts: true,
    createBackend() {
      throw new Error("Official Codex requires recovery");
    },
  });
  return {
    officialRuntimeScope: scope,
    accountControl: new UnavailableCodexAccounts(reason, () => ({
      phase: scope.gate.phase,
      revision: scope.gate.revision,
    })),
    allowNativeAuthPassthrough: false,
    close: () => scope.close(),
  };
}
function nativeListener(input: LocalCodexOptions, home: string): OwnedOfficialBackend {
  const token = randomBytes(32).toString("base64url");
  const listener = createLoopbackOfficialAppServerListener({
    stockCodexPath: input.stockCodexPath,
    arguments: [
      ...officialLoopbackListenerArguments(input.arguments),
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      createHash("sha256").update(token).digest("hex"),
    ],
    environment: { ...officialEnvironment(input.environment), CODEX_HOME: home },
    diagnosticOutput: discardNativeDiagnostics(),
  });
  let endpoint: string | undefined;
  return {
    closed: listener.closed,
    get processId() {
      return listener.processId;
    },
    async start() {
      endpoint = await listener.listen();
    },
    async connect() {
      if (!endpoint) throw new Error("Official listener unavailable");
      return createRemoteOfficialAppServerConnection(endpoint, { capabilityToken: token });
    },
    stop: () => listener.close(),
  };
}
function nativeFallback(
  input: LocalCodexOptions,
  home: string,
  reason: UnavailableCodexAccountReason,
  ownership?: {
    record: OfficialProcessRecord;
    store: NativeAccountStore;
    files: NativePrivateFiles;
    launcher: string;
  },
): PreparedLocalCodex {
  const scope = new OfficialRuntimeScope({
    permanentHome: home,
    diagnosticOutput: input.diagnosticOutput,
    allowNativeAuthPassthrough: true,
    createBackend: () => {
      if (ownership)
        return ownership.record.wrap((receipt) => {
          const launch = {
            stockCodexPath: input.stockCodexPath,
            cwd: home,
            arguments: input.sharedListener
              ? officialLoopbackListenerArguments(input.arguments)
              : input.arguments,
            environment: { ...officialEnvironment(input.environment), CODEX_HOME: home },
            supervision: { launcher: ownership.launcher, files: ownership.files, receipt },
          };
          return input.sharedListener
            ? createOwnedLoopbackBackend({
                ...launch,
                diagnosticOutput: discardNativeDiagnostics(),
              })
            : createOwnedStdioBackend(launch);
        });
      return input.sharedListener
        ? nativeListener(input, home)
        : createOwnedConnectionBackend(() =>
            spawnOfficialAppServerConnection({
              stockCodexPath: input.stockCodexPath,
              arguments: input.arguments,
              environment: { ...officialEnvironment(input.environment), CODEX_HOME: home },
            }),
          );
    },
  });
  const control = new SingleNativeCodexAccount(() => ({
    version: 2,
    currentAccountId: "native",
    phase: scope.gate.phase,
    revision: scope.gate.revision,
    capabilities: {
      manage: false,
      switch: false,
      login: false,
      delete: false,
      logout: false,
      recover: false,
      reason,
    },
    accounts: [{ accountId: "native", label: "Native Codex Account" }],
  }));
  return {
    officialRuntimeScope: scope,
    accountControl: control,
    allowNativeAuthPassthrough: true,
    close: async () => {
      await scope.close();
      await ownership?.store.close();
    },
  };
}

/** Local composition only. Transport remains independent of Account capability. */
export async function prepareLocalCodex(input: LocalCodexOptions): Promise<PreparedLocalCodex> {
  const home = await canonicalCodexHome(
    input.environment.CODEX_HOME ?? path.join(homedir(), ".codex"),
  );
  const data = path.resolve(
    input.environment.CODEXHOST_DATA_DIR ?? path.join(homedir(), ".codexhost"),
  );
  const layout = await inspectNativeAccountLayout(data, home);
  if (layout.kind === "migration-required")
    return blocked(home, input.diagnosticOutput, "migration-required");
  const root = path.join(home, ".codexhost-native-accounts");
  const launcher = input.environment.CODEXHOST_LAUNCHER_EXECUTABLE;
  // Without trusted native I/O, an existing managed directory cannot be assumed clean.
  if (!launcher || !path.isAbsolute(launcher)) {
    return (await exists(root)) || (await exists(path.join(home, ".codexhost-process.json")))
      ? blocked(home, input.diagnosticOutput, "recovery-required")
      : nativeFallback(input, home, "unsupported-storage");
  }
  const files = new NativePrivateFiles({ launcher, environment: input.environment });
  const homeFiles = files.withReadOnlyDirectoryAccess();
  let scope: OfficialRuntimeScope | undefined;
  const store = new NativeAccountStore({
    home,
    files,
    homeFiles,
    keys: new NativeSecretKeys({ launcher, environment: input.environment }),
    onLeaseLost: () => {
      scope?.gate.unavailable();
      void scope?.owner.stop().catch(() => undefined);
    },
  });
  let opened = false;
  try {
    const keyAvailable = await store.open({ allowLocked: true });
    opened = true;
    const processRecord = new OfficialProcessRecord({
      files,
      sharedCodexHome: store.directory,
      identity: (pid) => readNativeProcessIdentity(launcher, pid),
      assertOwnership: () => store.assertFileOwnership(),
      supervisorExitClosesProcessTree: process.platform === "win32",
    });
    const fallback = (reason: UnavailableCodexAccountReason): PreparedLocalCodex => {
      const result = nativeFallback(input, home, reason, {
        record: processRecord,
        store,
        files,
        launcher,
      });
      scope = result.officialRuntimeScope;
      return result;
    };
    if (!keyAvailable) {
      if ((await files.read(root, "transaction.json")) || (await files.read(root, "login.json"))) {
        await store.close();
        opened = false;
        return blocked(home, input.diagnosticOutput, "keyring-unavailable");
      }
      await processRecord.reconcile();
      return fallback("keyring-unavailable");
    }
    const reconcile = async (): Promise<void> => {
      await processRecord.reconcile();
      // A Host lease cannot constrain arbitrary native CLIs; refuse observable unknown writers.
      const pids = await readNativeProcessIds({
        launcher,
        executableNames: [path.basename(input.stockCodexPath), "codex", "codex.exe"],
        environment: input.environment,
      });
      if (pids.length) {
        input.diagnosticOutput.write(
          "codexhost: Other native Codex processes were detected; refusing Account management\n",
        );
        throw new Error("Another native process may own the Codex home");
      }
    };
    scope = new OfficialRuntimeScope({
      permanentHome: home,
      managedAccounts: true,
      diagnosticOutput: input.diagnosticOutput,
      allowNativeAuthPassthrough: false,
      createBackend: (role) =>
        processRecord.wrap((receipt) =>
          createOwnedLoopbackBackend({
            stockCodexPath: input.stockCodexPath,
            arguments: officialLoopbackListenerArguments(
              role.kind === "staging" ? ["app-server"] : input.arguments,
            ),
            cwd: role.home,
            environment:
              role.kind === "staging"
                ? stagingEnvironment(input.environment, role.home)
                : { ...officialEnvironment(input.environment), CODEX_HOME: role.home },
            diagnosticOutput: discardNativeDiagnostics(),
            supervision: { launcher, files, receipt },
          }),
        ),
    });
    const runtime = new OfficialAccountRuntime({
      owner: scope.owner,
      sharedCodexHome: home,
      environment: input.environment,
      readCredentials: (directory) => store.readCredentials(directory),
      nativeVersion: () =>
        readOfficialCliVersion(input.stockCodexPath, officialEnvironment(input.environment)),
      reconcilePreviousWriter: reconcile,
    });
    const accounts = new NativeCodexAccounts({ store, runtime });
    try {
      await accounts.initialize();
    } catch (error) {
      const reason =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (
        (reason === "unsupported-version" || reason === "unsupported-storage") &&
        !(await store.readJournal()) &&
        !(await store.readStage())
      ) {
        await runtime.stop();
        await accounts.close();
        await scope.close();
        return fallback(reason);
      }
      // Keep the management controller/recovery action, Desktop and external Harnesses alive.
      input.diagnosticOutput.write("codexhost: Codex Account recovery is required\n");
    }
    const officialRuntimeScope = scope;
    return {
      officialRuntimeScope,
      accountControl: accounts,
      allowNativeAuthPassthrough: false,
      close: async () => {
        await accounts.close();
        await officialRuntimeScope.close();
        await store.close();
      },
    };
  } catch {
    if (scope) {
      try {
        await scope.close();
      } catch {
        return blocked(home, input.diagnosticOutput, "recovery-required");
      }
    }
    if (opened) await store.close();
    return blocked(home, input.diagnosticOutput, "recovery-required");
  }
}
