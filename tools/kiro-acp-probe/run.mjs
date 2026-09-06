import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";

import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const { values } = parseArgs({
  options: {
    engine: { type: "string", default: "v2" },
    action: { type: "string", default: "inspect" },
    command: { type: "string", default: "kiro-cli" },
    cwd: { type: "string" },
    session: { type: "string" },
    model: { type: "string" },
    prompt: { type: "string" },
    method: { type: "string" },
    params: { type: "string", default: "{}" },
    before: { type: "string", default: "[]" },
    after: { type: "string", default: "[]" },
    "client-meta": { type: "string", default: '{"userInput":true}' },
    approve: { type: "boolean", default: false },
    "cancel-ms": { type: "string" },
    "cancel-on-permission": { type: "boolean", default: false },
    "question-response": { type: "string" },
    "trust-all": { type: "boolean", default: false },
    "self-test": { type: "boolean", default: false },
  },
});

function sanitize(value, key = "") {
  if (/^(accessToken|refreshToken|authorization|password|secret|runtimeToken)$/iu.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
      .replace(/(CODEXHOST_RUNTIME_TOKEN\s*[=:]\s*)\S+/gu, "$1[REDACTED]")
      .slice(0, 80_000);
  }
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [name, sanitize(entry, name)]),
    );
  }
  return value;
}

function pickPermission(options, approve) {
  return options.find((option) => option.kind === (approve ? "allow_once" : "reject_once"));
}

if (values["self-test"]) {
  assert.deepEqual(sanitize({ accessToken: "secret", inputTokens: 5 }), {
    accessToken: "[REDACTED]",
    inputTokens: 5,
  });
  assert.equal(sanitize("Bearer abc"), "Bearer [REDACTED]");
  const options = [
    { optionId: "always", kind: "allow_always" },
    { optionId: "once", kind: "allow_once" },
    { optionId: "no", kind: "reject_once" },
  ];
  assert.equal(pickPermission(options, true)?.optionId, "once");
  assert.equal(pickPermission(options, false)?.optionId, "no");
  console.log("PROBE_SELF_TEST_OK");
  process.exit(0);
}

assert.ok(["v1", "v2", "v3"].includes(values.engine), "Invalid engine");
assert.ok(
  ["inspect", "session", "turn", "rpc", "resume"].includes(values.action),
  "Invalid action",
);
if (values.action === "turn") assert.ok(values.prompt, "turn requires --prompt");
if (values.action === "rpc") assert.ok(values.method, "rpc requires --method");
if (values.action === "resume") assert.ok(values.session, "resume requires --session");
if (values.session) assert.ok(values.cwd, "Existing sessions require the probe cwd");
const rpcParams = JSON.parse(values.params);
const before = JSON.parse(values.before);
const after = JSON.parse(values.after);
const clientMeta = JSON.parse(values["client-meta"]);
assert.ok(Array.isArray(before) && Array.isArray(after), "before/after must be request arrays");
const cancelMs = values["cancel-ms"] === undefined ? undefined : Number(values["cancel-ms"]);
assert.ok(cancelMs === undefined || (Number.isInteger(cancelMs) && cancelMs > 0));

const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const runId = `${stamp}-${values.engine}-${values.action}`;
const runsRoot = path.resolve("D:/DevTools/kiro-acp-probe");
const cwd = values.cwd ? path.resolve(values.cwd) : path.join(runsRoot, runId, "workspace");
const relativeCwd = path.relative(runsRoot, cwd);
assert.ok(
  relativeCwd && !relativeCwd.startsWith("..") && !path.isAbsolute(relativeCwd),
  "Probe cwd must be under D:/DevTools/kiro-acp-probe",
);
const marker = path.join(cwd, ".kiro-acp-probe.json");
if (values.cwd) {
  assert.equal(JSON.parse(await readFile(marker, "utf8")).owner, "codexhost-kiro-acp-probe");
} else {
  await mkdir(cwd, { recursive: true });
  await writeFile(marker, JSON.stringify({ owner: "codexhost-kiro-acp-probe", runId }), "utf8");
  await writeFile(path.join(cwd, "sample.txt"), "alpha\n", "utf8");
}

const outputDirectory = path.resolve(".cache/kiro-acp-probe");
await mkdir(outputDirectory, { recursive: true });
const reportPath = path.join(outputDirectory, `${runId}.json`);
const report = {
  runId,
  startedAt: new Date().toISOString(),
  engine: values.engine,
  action: values.action,
  cwd,
  modelRequested: values.model ?? null,
  promptSubmitted: false,
  records: [],
};
let child;
let connection;
let sessionId = values.session;
let activePrompt = false;
let promptTimer;
const pendingQuestions = [];

function record(type, data) {
  report.records.push({ at: new Date().toISOString(), type, data: sanitize(data) });
}

async function timeout(promise, label, ms = 30_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cancel() {
  if (!activePrompt || !sessionId) return;
  record("cancel.request", { sessionId });
  await connection.cancel({ sessionId });
}

async function request(method, params) {
  record("request", { method, params });
  try {
    const result = await timeout(connection.request(method, params), method);
    record("response", { method, result });
    return result;
  } catch (error) {
    record("rpc.error", { method, code: error.code, message: error.message, data: error.data });
    throw error;
  }
}

try {
  const args = ["acp", "--agent-engine", values.engine];
  if (values.engine === "v3") args.push("--auth-method", "cli");
  if (values.model && values.engine !== "v3") args.push("--model", values.model);
  if (values["trust-all"]) args.push("--trust-all-tools");
  const environment = { ...process.env, KIRO_ACP_PROBE_MARKER: runId };
  for (const key of [
    "CODEXHOST_RUNTIME_TOKEN",
    "CODEXHOST_RUNTIME_ENDPOINT",
    "CODEXHOST_THREAD_ID",
  ]) {
    delete environment[key];
  }
  child = spawn(values.command, args, {
    cwd,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      record("process.exit", { code, signal });
      resolve();
    });
  });
  child.stderr.on("data", (chunk) => record("stderr", chunk.toString()));
  await timeout(
    new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }),
    "spawn",
  );
  connection = new ClientSideConnection(
    () => ({
      sessionUpdate: async (params) => record("session.update", params),
      requestPermission: async (params) => {
        record("permission.request", params);
        if (values["cancel-on-permission"]) {
          await cancel();
          return { outcome: { outcome: "cancelled" } };
        }
        const option = pickPermission(params.options, values.approve);
        const result = option
          ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } };
        record("permission.response", result);
        return result;
      },
      extMethod: async (method, params) => {
        record("extension.request", { method, params });
        if (method === "_kiro/userInput" && values["question-response"]) {
          const result = JSON.parse(values["question-response"]);
          record("extension.response", { method, result });
          return result;
        }
        // The probe must not supply credentials or silently answer unknown client requests.
        if (method === "_kiro/userInput") {
          return new Promise((resolve) => {
            pendingQuestions.push(() => resolve({ action: "dismissed" }));
            setTimeout(() => {
              void cancel().finally(() => resolve({ action: "dismissed" }));
            }, 500).unref();
          });
        }
        throw new Error(`Unsupported probe client method: ${method}`);
      },
      extNotification: async (method, params) =>
        record("extension.notification", { method, params }),
    }),
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  );
  await request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { _meta: { kiro: clientMeta } },
    clientInfo: { name: "codexhost-kiro-acp-probe", version: "0.1.0" },
  });
  if (values.action !== "inspect") {
    const opened = await request(sessionId ? "session/load" : "session/new", {
      cwd,
      mcpServers: [],
      ...(sessionId ? { sessionId } : {}),
    });
    sessionId ??= opened.sessionId;
    assert.ok(sessionId, "No session identity");
    report.sessionId = sessionId;
    if (values.model && values.engine === "v3") {
      await request("session/set_config_option", {
        sessionId,
        configId: "model",
        value: values.model,
      });
    }
    for (const entry of before) {
      await request(entry.method, { sessionId, ...entry.params });
    }
    if (values.action === "rpc") {
      await request(values.method, { sessionId, ...rpcParams });
    }
    if (values.action === "turn") {
      activePrompt = true;
      report.promptSubmitted = true;
      if (cancelMs) promptTimer = setTimeout(() => void cancel(), cancelMs);
      const params = { sessionId, prompt: [{ type: "text", text: values.prompt }] };
      record("request", { method: "session/prompt", params });
      const result = await timeout(connection.prompt(params), "session/prompt", 120_000);
      activePrompt = false;
      record("response", { method: "session/prompt", result });
    }
    for (const entry of after) {
      try {
        await request(entry.method, { sessionId, ...entry.params });
      } catch (error) {
        if (!entry.allowError) throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  report.ok = true;
  child.stdin.end();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 800))]);
} catch (error) {
  report.ok = false;
  record("probe.error", { message: error.message, code: error.code });
  process.exitCode = 1;
  if (activePrompt) await timeout(cancel(), "cancel", 2_000).catch(() => {});
} finally {
  clearTimeout(promptTimer);
  for (const resolve of pendingQuestions) resolve();
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32") {
      const killed = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        encoding: "utf8",
        timeout: 5_000,
      });
      record("process.cleanup", { forcedTree: true, exitCode: killed.status });
    } else {
      child.kill("SIGTERM");
    }
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", resolve);
    });
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const counts = {};
  for (const entry of report.records) {
    const key =
      entry.type === "session.update"
        ? entry.data.update?.sessionUpdate
        : entry.type === "extension.notification"
          ? entry.data.method
          : entry.type;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  console.log(JSON.stringify({ reportPath, ...report, records: undefined, counts }, null, 2));
}
