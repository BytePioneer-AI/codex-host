import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { NativeAccountStore } from "../src/account/native-account-store.js";
import { NativeCodexAccounts } from "../src/account/native-codex-accounts.js";
import { OfficialAccountRuntime } from "../src/account/official-account-runtime.js";
import { readOfficialCliVersion } from "../src/codex-runtime/official-cli-version.js";
import { OfficialProcessRecord } from "../src/codex-runtime/official-process-record.js";
import {
  OfficialRuntimeClient,
  OfficialRuntimeScope,
} from "../src/codex-runtime/official-runtime-scope.js";
import { createOwnedLoopbackBackend } from "../src/codex-runtime/owned-official-backends.js";
import { NativePrivateFiles } from "../src/native-private-files.js";
import { readNativeProcessIdentity } from "../src/native-process-identity.js";
import { officialLoopbackListenerArguments } from "../src/remote-app-server.js";

// Explicit opt-in only: real official CLI + real helper, but never a user's home,
// credential or OS keyring. OAuth is cancelled without opening its URL or
// completing authentication; external HTTP uses a denying loopback proxy. No inference.
const stock = process.env.CODEXHOST_TEST_OFFICIAL_CODEX;
const launcher = process.env.CODEXHOST_TEST_NATIVE_LAUNCHER;

describe.skipIf(!stock || !launcher)("real official CLI with an isolated signed-out home", () => {
  it("boots managed file storage through the actual protected listener before Desktop attaches", async () => {
    if (!stock || !launcher) throw new Error("Explicit native executables are required");
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "codexhost-official-probe-")));
    const home = path.join(root, "codex");
    await mkdir(home, { mode: 0o700 });
    await writeFile(
      path.join(home, "config.toml"),
      'cli_auth_credentials_store = "file"\n[features]\nplugins = false\n',
      { mode: 0o600 },
    );
    const environment: NodeJS.ProcessEnv = {
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: home,
      PATH: path.dirname(stock),
      TMPDIR: tmpdir(),
      TMP: tmpdir(),
      TEMP: tmpdir(),
      ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "localhost,127.0.0.1",
    };
    const files = new NativePrivateFiles({ launcher, environment });
    const store = new NativeAccountStore({
      home,
      files,
      homeFiles: files.withReadOnlyDirectoryAccess(),
      keys: {
        read: async () => Buffer.alloc(32, 0x51),
        create: async () => Buffer.alloc(32, 0x51),
      },
    });
    const diagnosticOutput = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const record = new OfficialProcessRecord({
      files,
      sharedCodexHome: store.directory,
      identity: (pid) => readNativeProcessIdentity(launcher, pid),
      assertOwnership: () => store.assertFileOwnership(),
      supervisorExitClosesProcessTree: process.platform === "win32",
    });
    let live = 0;
    let peak = 0;
    const scope = new OfficialRuntimeScope({
      permanentHome: home,
      managedAccounts: true,
      diagnosticOutput,
      createBackend: (role) =>
        record.wrap((receipt) => {
          const backend = createOwnedLoopbackBackend({
            stockCodexPath: stock,
            arguments: officialLoopbackListenerArguments(["app-server"]),
            environment: { ...environment, CODEX_HOME: role.home },
            cwd: role.home,
            diagnosticOutput,
            supervision: { launcher, files, receipt },
          });
          let started = false;
          return {
            get processId() {
              return backend.processId;
            },
            closed: backend.closed,
            async start() {
              live += 1;
              peak = Math.max(peak, live);
              started = true;
              await backend.start();
            },
            connect: () => backend.connect(),
            async stop() {
              await backend.stop();
              if (started) {
                live -= 1;
                started = false;
              }
            },
          };
        }),
    });
    const runtime = new OfficialAccountRuntime({
      owner: scope.owner,
      sharedCodexHome: home,
      readCredentials: (directory) => store.readCredentials(directory),
      environment,
      nativeVersion: () => readOfficialCliVersion(stock, environment),
      // This randomized private test home has no external users. Keep the real
      // owned-writer reconciliation; application-wide inventory has its own tests.
      reconcilePreviousWriter: () => record.reconcile(),
    });
    let accounts: NativeCodexAccounts | undefined;
    let desktop: OfficialRuntimeClient | undefined;
    try {
      await store.open();
      accounts = new NativeCodexAccounts({ store, runtime });
      await accounts.initialize();
      expect(accounts.snapshot()).toMatchObject({ phase: "ready", currentAccountId: null });
      expect(scope.owner.running).toBe(true);
      desktop = new OfficialRuntimeClient({ scope, output: async () => {} });
      await desktop.initialize();
      await expect(
        desktop.initializeProtocol({
          clientInfo: { name: "codex_desktop", version: "synthetic" },
          capabilities: { experimentalApi: true },
        }),
      ).resolves.toMatchObject({
        result: {
          codexHome: home,
          platformFamily: expect.any(String),
          platformOs: expect.any(String),
        },
      });
      await expect(
        runtime.controlRequest("account/read", { refreshToken: false }),
      ).resolves.toMatchObject({ result: { account: null } });
      expect(await store.readCredentials()).toBeNull();

      const login = await accounts.startNativeLogin({ type: "chatgpt" });
      // Do not print the native OAuth URL/state or open a browser.
      expect(login.response.type).toBe("chatgpt");
      expect(scope.gate.phase).toBe("changing");
      expect(await store.readCredentials()).toBeNull();
      expect(await accounts.cancelLogin(login.response.loginId)).toBe(true);
      expect((await login.completed).success).toBe(false);
      expect(await store.readStage()).toBeNull();
      expect(await store.readCredentials()).toBeNull();
      expect(scope.gate.phase).toBe("ready");
      expect(scope.owner.running).toBe(true);

      // Native Thread creation is not a Turn: this exercises persistence and
      // permissions without asking a Model to perform work or authenticating.
      const started = await desktop.request("thread/start", {
        cwd: home,
        runtimeWorkspaceRoots: [home],
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: false,
      });
      const original = z
        .object({
          thread: z.object({ id: z.string(), ephemeral: z.literal(false), path: z.string() }),
          model: z.string(),
          modelProvider: z.string(),
          approvalPolicy: z.literal("never"),
          sandbox: z.unknown(),
          cwd: z.string(),
        })
        .parse(started.result);
      await vi.waitFor(() => expect(scope.gate.busy).toBe(false));
      // Native 0.153.4 returns a planned path before materializing the rollout.
      // Reject replacement, but leave this in-memory Thread and writer alive.
      await expect(runtime.assertNativeIdle()).rejects.toMatchObject({ code: "busy" });
      expect(scope.gate.phase).toBe("ready");
      expect(live).toBe(1);
      await expect(
        desktop.request("thread/read", {
          threadId: original.thread.id,
          includeTurns: false,
        }),
      ).resolves.toMatchObject({ result: { thread: { id: original.thread.id } } });
      expect(peak).toBe(1);
    } finally {
      await desktop?.close();
      await accounts?.close();
      await scope.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
