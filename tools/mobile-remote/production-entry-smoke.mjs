// Actual packaged entry + real native CLI, isolated home and explicitly synthetic plugin.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, writeFile, cp, rm } from "node:fs/promises";
import path from "node:path";
import { buildReleaseHostBundle } from "../../packages/host-runtime/scripts/build-release.mjs";
import { startNativeToolModel } from "./native-tool-model.mjs";
import { connectHost } from "./synthetic-host.mjs";
const [artifact, stock, catalog, report] = process.argv.slice(2);
if (![artifact, stock, catalog, report].every((value) => value && path.isAbsolute(value)))
  throw new Error(
    "Pass absolute artifact directory, stock Codex CLI, official model catalog and report paths",
  );
const expectBridge = !process.argv.includes("--missing-helper");
const root = process.cwd();
const directory = await mkdtemp("/tmp/ch-production-entry-");
const app = path.join(directory, "app");
const home = path.join(directory, "home");
const temporary = path.join(home, "tmp");
let child;
let mobile;
let exited;
let result;
const pending = new Map();
const notifications = [];
const model = await startNativeToolModel();
try {
  await mkdir(temporary, { recursive: true });
  await mkdir(path.join(home, "codex"));
  await buildReleaseHostBundle({
    repositoryRoot: root,
    outputPath: path.join(app, "host-runtime.mjs"),
  });
  await cp(artifact, path.join(app, "mobile-codex"), { recursive: true });
  if (!expectBridge) await rm(path.join(app, "mobile-codex/bin/codex-code-mode-host"));
  const plugin = path.join(app, "plugins", "pi");
  await mkdir(plugin, { recursive: true });
  await writeFile(
    path.join(app, "plugins/enabled.json"),
    JSON.stringify({ version: 1, enabled: ["pi"] }),
  );
  await writeFile(
    path.join(plugin, "manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: "pi",
      name: "Synthetic acceptance",
      version: "0.0.0",
      adapterApiVersion: 1,
      entry: "plugin.mjs",
    }),
  );
  const testing = import.meta.resolve("@codexhost/harness-adapter/testing");
  await writeFile(
    path.join(plugin, "plugin.mjs"),
    `import { FakeHarnessAdapter } from ${JSON.stringify(testing)};
export function createHarnessAdapter() {
 const adapter = new FakeHarnessAdapter("pi");
 const open = adapter.open.bind(adapter);
 adapter.open = async (input) => {
  const result = await open(input);
  if (result.ok) {
   const session = result.value, execute = session.execute.bind(session);
   session.execute = async (command) => {
    const reply = await execute(command);
    if (reply.ok && command.type === "turn.start") setTimeout(() => { session.appendText("Production shared owner reply"); session.succeedTurn(); }, 30);
    return reply;
   };
  }
  return result;
 };
 return adapter;
}`,
  );
  const models = JSON.parse(await readFile(catalog, "utf8"));
  await writeFile(
    path.join(home, "models.json"),
    JSON.stringify({ models: models.models.slice(0, 1) }),
  );
  await writeFile(
    path.join(home, "codex/config.toml"),
    `model_catalog_json = ${JSON.stringify(path.join(home, "models.json"))}\ncli_auth_credentials_store = "file"\nmodel_provider = "acceptance"\n[features]\ncode_mode = true\ncode_mode_only = true\n[code_mode]\ndisable_in_process_fallback = true\n[model_providers.acceptance]\nname = "Local acceptance model"\nbase_url = "${model.url}"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
  );
  child = spawn(process.execPath, [path.join(app, "host-runtime.mjs"), "app-server"], {
    cwd: home,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: home,
      TMPDIR: temporary,
      CODEX_HOME: path.join(home, "codex"),
      CODEXHOST_DATA_DIR: path.join(home, "host"),
      CODEXHOST_STOCK_CODEX_PATH: stock,
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "localhost,127.0.0.1",
    },
  });
  exited = once(child, "exit");
  let diagnostic = "";
  child.stderr.on("data", (chunk) => {
    diagnostic = (diagnostic + chunk).slice(-16000);
  });
  let buffer = "",
    id = 0;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const frame = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (frame.method) notifications.push(frame);
      const request = pending.get(frame.id);
      if (request && !frame.method) {
        pending.delete(frame.id);
        clearTimeout(request.timer);
        frame.error
          ? request.reject(new Error(JSON.stringify(frame.error)))
          : request.resolve(frame.result);
      }
    }
  });
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Production request timeout: ${method}; ${diagnostic}`));
      }, 30000);
      pending.set(requestId, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id: requestId, method, params }) + "\n");
    });
  await request("initialize", {
    clientInfo: { name: "production-entry-test", version: "1" },
    capabilities: { experimentalApi: true },
  });
  const { thread } = await request("thread/start", { model: "codexhost/pi-native", cwd: home });
  await request("thread/name/set", { threadId: thread.id, name: "Production entry shared thread" });
  const socketDirectories = (await readdir(temporary)).filter((name) =>
    name.startsWith("ch-mobile-"),
  );
  assert.equal(socketDirectories.length, expectBridge ? 1 : 0);
  if (expectBridge) {
    const socketPath = path.join(temporary, socketDirectories[0], "host.sock");
    mobile = await connectHost(socketPath, "production-second-client");
    const read = await mobile.request("thread/read", { threadId: thread.id, includeTurns: true });
    assert.equal(read.thread.name, "Production entry shared thread");
  } else {
    assert(diagnostic.includes("using official Codex"));
  }
  await (mobile?.request ?? request)("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "synthetic production entry acceptance" }],
  });
  let history;
  for (let count = 0; count < 100; count++) {
    history = await request("thread/read", { threadId: thread.id, includeTurns: true });
    if (history.thread.turns.at(-1)?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(history.thread.turns.at(-1)?.status, "completed");
  assert(JSON.stringify(history).includes("Production shared owner reply"));
  assert(Array.isArray((await request("model/list")).data));
  // This exercises the previously missing sibling executable through the real
  // native app-server, not by directly starting the helper or using a Fake tool.
  const native = await request("thread/start", {
    model: models.models[0].slug,
    modelProvider: "acceptance",
    cwd: home,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  const nativeTurn = await request("turn/start", {
    threadId: native.thread.id,
    input: [{ type: "text", text: "Run the deterministic local tool acceptance." }],
  });
  const deadline = Date.now() + 60000;
  let completed;
  while (Date.now() < deadline) {
    completed = notifications.find(
      (event) =>
        event.method === "turn/completed" &&
        event.params.threadId === native.thread.id &&
        event.params.turn.id === nativeTurn.turn.id,
    );
    if (completed) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(completed, `Native tool Turn did not complete: ${diagnostic}`);
  assert.equal(completed.params.turn.status, "completed", JSON.stringify(completed));
  model.verify(expectBridge ? path.join(app, "mobile-codex/codex-path/rg") : undefined);
  await mobile?.close();
  mobile = undefined;
  child.stdin.end();
  const [code] = await Promise.race([
    exited,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Host cleanup timeout")), 20000);
      timer.unref();
    }),
  ]);
  assert.equal(code, 0);
  assert(!(await readdir(temporary)).some((name) => name.startsWith("ch-mobile-")));
  result = {
    passed: true,
    actualProductionEntry: true,
    packagedBridgeSelected: expectBridge,
    independentClients: expectBridge,
    missingHelperUsesWorkingOfficialRuntime: !expectBridge,
    sameOwnerHistoryAndTurn: true,
    nativeCallback: true,
    nativeCodeModeAndNestedShell: true,
    bundledSearchWithoutUserPath: expectBridge,
    cleanup: true,
  };
  await writeFile(report, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  await mobile?.close();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5000);
        timer.unref();
      }),
    ]);
  }
  await model.close();
  await rm(directory, { recursive: true, force: true });
}
