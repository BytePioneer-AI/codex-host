// THROWAWAY feasibility probe, NOT a plugin backend or a supported Desktop interface.
// macOS ZCode Desktop 3.12.3 only. Uses the installed, unmodified Host and RPC modules.
// The launcher copies this file into a scratch profile, denies access to the real HOME
// and all network except scratch Unix sockets. Cleanup verifies scratch cwd ownership,
// including native children that detach into another process group.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, MessageChannel, parentPort, Worker } from "node:worker_threads";
import { cleanupScratchProcesses } from "./scratch-processes.mjs";

const resources = "/Applications/ZCode.app/Contents/Resources";
const executable = "/Applications/ZCode.app/Contents/MacOS/ZCode";
const hostDirectory = `${resources}/app.asar/out/host`;
const report = (stage, detail = {}) => console.log(JSON.stringify({ stage, ...detail }));

async function launch() {
  assert.equal(process.platform, "darwin", "This prototype requires macOS sandbox-exec");
  const args = process.argv.slice(2);
  assert.ok(
    args.length <= 1 &&
      args.every((arg) =>
        ["--personal-fixture", "--paired-fixture", "--adapter-fixture"].includes(arg),
      ),
  );
  const fixture = args.length === 1;
  const paired = args[0] === "--paired-fixture";
  // Short paths matter: the native runtime creates a Unix socket below TMPDIR.
  const root = await realpath(await mkdtemp("/tmp/zcf-"));
  let child;
  let timer;
  let cleanup;
  const cleanOwnedProcesses = () => (cleanup ??= cleanupScratchProcesses(root));
  const interrupt = () => {
    process.exitCode = 1;
    void cleanOwnedProcesses().catch(() => {
      report("scratch-cleanup-unconfirmed");
    });
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await Promise.all(["tmp", "logs"].map((name) => mkdir(path.join(root, name))));
    const script = path.join(root, "probe.mjs");
    await copyFile(fileURLToPath(import.meta.url), script);
    for (const name of ["paired-catalog.mjs", "paired-relay.mjs", "scratch-processes.mjs"]) {
      await copyFile(new URL(name, import.meta.url), path.join(root, name));
    }
    if (args[0] === "--adapter-fixture") {
      const { build } = await import("esbuild");
      await build({
        stdin: {
          contents:
            'export { ZcodeAdapter } from "./index.js"; export { ZcodeError } from "./errors.js"; export { desktopWorker } from "./desktop-worker.js";',
          resolveDir: fileURLToPath(new URL("../dist/", import.meta.url)),
          sourcefile: "adapter-fixture-entry.js",
        },
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        outfile: path.join(root, "adapter.mjs"),
        logLevel: "silent",
      });
      for (const name of ["adapter-fixture.mjs", "worker-fixture.mjs"])
        await copyFile(new URL(name, import.meta.url), path.join(root, name));
    }
    if (fixture) {
      const directory = path.join(root, ".zcode", "v2");
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "provider_config.json"),
        JSON.stringify({
          schemaVersion: 1,
          config: {
            providerConfigRules: {
              providerRules: [
                {
                  providerId: "fixture",
                  providerName: "Fixture",
                  enabled: true,
                  config: {
                    group: "standard-personal",
                    access: { type: "api-key", apiKey: "test-only" },
                    api: { type: "anthropic-messages", baseUrl: "http://127.0.0.1:1" },
                    personalModelIds: ["fixture-model"],
                  },
                },
              ],
            },
            modelConfigRules: {
              providerModelRules: [
                {
                  providerId: "fixture",
                  modelId: "fixture-model",
                  config: { optionSpecs: { reasoningLevel: { values: ["disabled"], map: "{}" } } },
                },
              ],
              manualProviderModelRules: [],
            },
            defaultModelSelection: { providerId: "fixture", modelId: "fixture-model" },
          },
        }),
      );
    }
    const quote = JSON.stringify;
    const policy = `(version 1)
(allow default)
(deny signal)
(deny file-write*)
(allow file-write* (subpath ${quote(root)}) (literal "/dev/null"))
(deny network*)
(allow network* (local unix-socket (subpath ${quote(root)})) (remote unix-socket (subpath ${quote(root)})))
(deny process-exec (literal "/usr/bin/open"))
(deny file-read* file-write* (subpath ${quote(await realpath(homedir()))}))`;
    child = spawn("/usr/bin/sandbox-exec", ["-p", policy, executable, script], {
      cwd: root,
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: root,
        USERPROFILE: root,
        TMPDIR: path.join(root, "tmp"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        ZCODE_HOME: path.join(root, ".zcode"),
        ZCODE_DATA_BASE_DIR: root,
        ZCODE_SESSION_DB_PATH: path.join(root, "sessions.sqlite"),
        ZCODE_LOG_DIR: path.join(root, "logs"),
        ZCODE_PROCESS_LABEL: "codexhost-zcode-feasibility",
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: `${resources}/config/provider/zcode-builtin.json`,
        ELECTRON_RUN_AS_NODE: "1",
        NO_PROXY: "*",
        ZCODE_NO_PROXY: "*",
        CODEXHOST_ZCODE_PROBE_SANDBOXED: "1",
        CODEXHOST_ZCODE_PROBE_FIXTURE: fixture ? "1" : "0",
        CODEXHOST_ZCODE_PROBE_PAIRED: paired ? "1" : "0",
        CODEXHOST_ZCODE_PROBE_ADAPTER: args[0] === "--adapter-fixture" ? "1" : "0",
      },
    });
    timer = setTimeout(interrupt, 60_000);
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (status) => resolve(status ?? 1));
    });
    process.exitCode = code;
  } finally {
    clearTimeout(timer);
    await cleanOwnedProcesses();
    report("owned-scratch-processes-stopped");
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await rm(root, { recursive: true, force: true });
    report("scratch-profile-removed");
  }
}

async function runNativeHost() {
  // Only the UtilityProcess transport is adapted, not ZCode's business behavior.
  const wrapPort = (port) => {
    const events = new EventEmitter();
    port.on("message", (data) => events.emit("message", { data, ports: [] }));
    port.on("close", () => events.emit("close"));
    events.postMessage = (data) => port.postMessage(data);
    events.start = () => port.start();
    events.close = () => port.close();
    return events;
  };
  const upstream = new EventEmitter();
  upstream.postMessage = (data) => parentPort.postMessage(data);
  parentPort.on("message", ({ data, ports = [] }) => {
    upstream.emit("message", { data, ports: ports.map(wrapPort) });
  });
  process.parentPort = upstream;
  await import(`${hostDirectory}/index.js`);
  parentPort.postMessage({ type: "probe-loaded" });
}

async function probe() {
  const pkg = JSON.parse(await readFile(`${resources}/app.asar/package.json`, "utf8"));
  assert.equal(pkg.version, "3.12.3", "Private protocol probe is pinned to Desktop 3.12.3");
  report("version", { desktop: pkg.version, electron: process.versions.electron });
  const timer = setTimeout(() => {
    report("timeout");
    process.exit(1);
  }, 45_000);
  const rpc = await import(`${hostDirectory}/chunk-PRPNU2MC.js`);
  const api = await import(`${hostDirectory}/chunk-3CQYXRMM.js`);
  const exported = (module, name) => {
    const values = Object.values(module).filter(
      (value) => typeof value === "function" && value.name === name,
    );
    assert.equal(values.length, 1, `Private export changed: ${name}`);
    return values[0];
  };
  const Protocol = exported(rpc, "MessagePortProtocol");
  const ChannelClient = exported(rpc, "ChannelClient");
  const Services = exported(api, "RemoteServiceAccess");
  const worker = new Worker(new URL(import.meta.url), { stdout: true, stderr: true });
  // Native logs are not a result and are never printed or retained in this repository.
  worker.stdout.resume();
  worker.stderr.resume();
  const loaded = new Promise((resolve, reject) => {
    worker.on("message", (message) => {
      if (message.type === "probe-loaded") resolve();
    });
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`Isolated Host exited: ${code}`)));
  });
  const connect = (message) => {
    const { port1, port2 } = new MessageChannel();
    const protocol = new Protocol(port1);
    const client = new ChannelClient(protocol);
    const initialized = new Promise((resolve) => client.onDidInitialize(resolve));
    worker.postMessage({ data: message, ports: [port2] }, [port2]);
    return {
      services: new Services(client),
      client,
      initialized,
      close: () => {
        client.dispose();
        protocol.disconnect();
      },
    };
  };
  let first, second;
  try {
    await loaded;
    first = connect({
      type: "init-local",
      databaseStartupId: "codexhost-feasibility",
      agentSpawnFallbackCwd: process.env.HOME,
      zcodeBuiltinProviderConfigFilePath: `${resources}/config/provider/zcode-builtin.json`,
    });
    await first.initialized;
    report("native-channel-connected");
    const view = await first.services.modelSelectionService.getView();
    report("native-catalog", {
      providers: view.providers.length,
      models: view.providers.reduce((count, provider) => count + provider.models.length, 0),
    });
    second = connect({
      type: "attach-service-port",
      requestId: "probe-attach-2",
      attachmentId: "probe-attachment-2",
      clientMode: "web-remote-replayable",
      scope: { kind: "local" },
    });
    await second.initialized;
    report("replayable-attachment-connected");
    first.close();
    first = undefined;
    const nextView = await second.services.modelSelectionService.getView();
    assert.equal(nextView.providers.length, view.providers.length);
    report("attachment-isolation-passed");
    const agent = second.services.zcodeAgentService;
    const workspace = { workspacePath: process.env.HOME };
    const create = () =>
      agent.createSession({
        ...workspace,
        persistence: "deferred",
        titleGenerationEnabled: false,
        mcpServers: [],
      });
    if (process.env.CODEXHOST_ZCODE_PROBE_ADAPTER === "1") {
      const { probeAdapter } = await import("./adapter-fixture.mjs");
      const { workerChannel } = await import("./worker-fixture.mjs");
      const relayModule = await import(`${resources}/app.asar/out/main/chunk-E6IDJBYU.js`);
      const helper = await workerChannel(
        exported(relayModule, "createAcknowledgedWebRemoteControlRelayProtocol"),
        () => {
          const { port1, port2 } = new MessageChannel();
          const protocol = new Protocol(port1);
          worker.postMessage(
            {
              data: {
                type: "attach-service-port",
                requestId: "adapter-fixture",
                attachmentId: "adapter-worker-fixture",
                clientMode: "web-remote-replayable",
                scope: { kind: "local" },
              },
              ports: [port2],
            },
            [port2],
          );
          return protocol;
        },
      );
      try {
        await probeAdapter(
          helper.channel,
          process.env.HOME,
          second.client.getChannel("zcode-agent"),
        );
      } finally {
        await helper.close();
      }
      report("production-adapter-native-fixture-passed", {
        account: "synthetic",
        prompts: 0,
        storage: "scratch-only",
      });
    } else if (process.env.CODEXHOST_ZCODE_PROBE_PAIRED === "1") {
      const { probePairedCatalog } = await import("./paired-catalog.mjs");
      const relayModule = await import(`${resources}/app.asar/out/main/chunk-E6IDJBYU.js`);
      const createProtocol = exported(
        relayModule,
        "createAcknowledgedWebRemoteControlRelayProtocol",
      );
      const listeners = new Set();
      let gateway, upstream;
      const relay = {
        signal: new AbortController().signal,
        onPayload: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        sendPayload: (payload) => gateway.acceptPayload(payload),
        request: async (type, responseType, params) => {
          if (type === "workspace-list-request")
            return {
              success: true,
              result: { workspaces: [{ kind: "local", workspacePath: process.env.HOME }] },
            };
          assert.equal(type, "workspace-bridge-open");
          const { port1, port2 } = new MessageChannel();
          upstream = new Protocol(port1);
          gateway = createProtocol({
            bridgeSessionId: params.bridgeSessionId,
            bridgeGeneration: params.bridgeGeneration,
            sendFrame: (frame) => {
              queueMicrotask(() => {
                for (const listener of listeners) listener(frame);
              });
              return true;
            },
          });
          upstream.onMessage((message) => gateway.protocol.send(message));
          gateway.protocol.onMessage((message) => upstream.send(message));
          worker.postMessage(
            {
              data: {
                type: "attach-service-port",
                requestId: "probe-relay-attach",
                attachmentId: "probe-relay-attachment",
                clientMode: "web-remote-replayable",
                scope: { kind: "local" },
              },
              ports: [port2],
            },
            [port2],
          );
          return {
            ...params,
            zcode_type: responseType,
            bridge: { ...params, kind: "local", workspacePath: process.env.HOME },
          };
        },
        close: () => {
          listeners.clear();
          gateway?.dispose();
          upstream?.disconnect();
        },
      };
      const result = await probePairedCatalog(relay, {
        cwd: process.env.HOME,
        createProtocol,
        createRpc: (protocol) => new ChannelClient(protocol),
      });
      assert.equal(result.cleanupConfirmed, true);
      assert.equal(result.models.length, 1);
      assert.equal(result.models[0].providerId, "fixture");
      assert.equal((await agent.listSessions({ ...workspace, limit: 100 })).length, 0);
      report("paired-probe-native-session-passed", {
        relayPairing: "simulated",
        persistedSessions: 0,
      });
    } else if (process.env.CODEXHOST_ZCODE_PROBE_FIXTURE !== "1") {
      assert.equal(view.providers.length, 0);
      await assert.rejects(create(), /供应商|模型|provider|model/i);
      report("empty-account-rejected-as-expected");
    } else {
      assert.equal(view.providers.length, 1);
      assert.equal(view.providers[0].providerId, "fixture");
      const snapshots = [];
      try {
        for (let index = 0; index < 2; index++) {
          const snapshot = await create();
          snapshots.push(snapshot);
          assert.equal(snapshot.messages.length, 0);
          assert.equal(snapshot.settings.model.available.length, 1);
          report("empty-session-created", { index });
        }
        assert.notEqual(snapshots[0].session.sessionId, snapshots[1].session.sessionId);
        report("independent-session-identities-passed");
        assert.equal(
          await agent.closeSession({
            ...workspace,
            sessionId: snapshots[0].session.sessionId,
            expectedPersistence: "deferred",
          }),
          true,
        );
        snapshots.shift();
        const remaining = await agent.readSession({
          ...workspace,
          sessionId: snapshots[0].session.sessionId,
        });
        assert.equal(remaining.session.sessionId, snapshots[0].session.sessionId);
        report("session-close-isolation-passed");
      } finally {
        for (const snapshot of snapshots) {
          assert.equal(
            await agent.closeSession({
              ...workspace,
              sessionId: snapshot.session.sessionId,
              expectedPersistence: "deferred",
            }),
            true,
          );
        }
      }
      const listed = await agent.listSessions({ ...workspace, limit: 100 });
      assert.ok(Array.isArray(listed));
      assert.equal(listed.length, 0);
      report("no-persisted-sessions");
    }
    report("passed");
  } finally {
    first?.close();
    second?.close();
    await worker.terminate();
    clearTimeout(timer);
  }
}

try {
  if (process.env.CODEXHOST_ZCODE_PROBE_SANDBOXED !== "1") await launch();
  else if (isMainThread) await probe();
  else await runNativeHost();
} catch (error) {
  report("failed", { name: error.name, message: error.message });
  process.exitCode = 1;
}
