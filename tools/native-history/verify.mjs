import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { NativeHistoryExport } from "../../packages/host-runtime/dist/native-history-export.js";

const [binary, output] = process.argv.slice(2);
if (!binary || !output || !path.isAbsolute(binary) || !path.isAbsolute(output)) {
  throw new Error(
    "Usage: node tools/native-history/verify.mjs <absolute-stock-codex> <absolute-output-directory>",
  );
}
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(output, "isolated-"));
const home = path.join(root, "home");
await mkdir(home, { recursive: true });
await writeFile(
  path.join(home, "config.toml"),
  'model="history-fixture"\nmodel_provider="offline"\n[model_providers.offline]\nname="Offline history fixture"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\n',
);
const createdAt = new Date().toISOString();
const record = {
  formatVersion: 1,
  revision: 1,
  hostThreadId: randomUUID(),
  harnessId: "omp",
  state: "ready",
  nativeSessionRef: { harnessId: "omp", nativeSessionId: "isolated-fixture", formatVersion: 1 },
  cwd: root,
  title: "External history fixture",
  ephemeral: false,
  archived: false,
  turnMappings: [],
  createdAt,
};
const turns = ["completed", "failed", "interrupted"].map((status, index) => ({
  id: randomUUID(),
  status,
  startedAt: Date.now() / 1000,
  completedAt: Date.now() / 1000,
  error: status === "failed" ? { message: "Synthetic quota rejection" } : null,
  items: [
    { type: "userMessage", content: [{ type: "text", text: `EXTERNAL USER ${index} 🙂` }] },
    {
      type: "commandExecution",
      command: "read README",
      aggregatedOutput: "SYNTHETIC TOOL OBSERVATION",
    },
    { type: "agentMessage", text: `EXTERNAL ASSISTANT ${index}`, phase: "final_answer" },
  ],
}));
const failures = [];
const stderr = [];
const exporter = new NativeHistoryExport(path.join(root, "staging"), home, (error) =>
  failures.push(String(error)),
);
// Establish an existing native state database before publishing the copy.
await withServer((request) => request("thread/list", { limit: 1, useStateDbOnly: true }));
exporter.stage(record, turns);
await exporter.exportOnExit([record]);
assert.deepEqual(failures, []);
const files = (await readdir(home, { recursive: true })).filter((name) => name.endsWith(".jsonl"));
assert.equal(files.length, 1);
const metadata = JSON.parse(
  (await readFile(path.join(home, files[0]), "utf8")).split("\n")[0],
).payload;

// This creates only a test child. CODEX_HOME is never inherited; no credentials
// or user history are copied. There are no turn/start or network model requests.
async function withServer(operation) {
  const child = spawn(binary, ["app-server", "--listen", "stdio://"], {
    env: { ...process.env, CODEX_HOME: home },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let sequence = 0;
  const pending = new Map();
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  child.on("error", (error) => {
    for (const entry of pending.values()) entry.reject(error);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out: ${method}`));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  try {
    await request("initialize", {
      clientInfo: { name: "history_read_fixture", version: "0.0.1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write('{"method":"initialized"}\n');
    return await operation(request);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => child.kill(), 1500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    for (const entry of pending.values()) clearTimeout(entry.timer);
  }
}
const evidence = { root, nativeThreadId: metadata.id, externalThreadId: record.hostThreadId };
try {
  await withServer((request) =>
    request("thread/read", { threadId: metadata.id, includeTurns: false }),
  );
  await withServer(async (request) => {
    evidence.list = await request("thread/list", {
      limit: 50,
      modelProviders: ["openai"],
      sourceKinds: ["vscode"],
      useStateDbOnly: true,
    });
    evidence.read = await request("thread/read", { threadId: metadata.id, includeTurns: true });
    assert(evidence.list.data.some((entry) => entry.id === metadata.id));
    assert.equal(evidence.read.thread.turns.length, 3);
    assert.deepEqual(
      evidence.read.thread.turns.map((turn) => turn.status),
      ["completed", "failed", "interrupted"],
    );
    for (let index = 0; index < turns.length; index++) {
      const text = JSON.stringify(evidence.read.thread.turns[index]);
      assert(text.includes(`EXTERNAL USER ${index}`));
      assert(text.includes(`EXTERNAL ASSISTANT ${index}`));
      assert(text.includes("SYNTHETIC TOOL OBSERVATION"));
    }
    evidence.passed = true;
  });
} finally {
  evidence.stderr = stderr;
  await writeFile(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
}
console.log(
  JSON.stringify(
    {
      passed: evidence.passed,
      evidence: path.join(root, "evidence.json"),
      statuses: evidence.read?.thread.turns.map((turn) => turn.status),
    },
    null,
    2,
  ),
);
