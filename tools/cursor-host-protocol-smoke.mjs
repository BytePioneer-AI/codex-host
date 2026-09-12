import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { AppServerHost } from "../packages/host-runtime/dist/index.js";
import { encodeHarnessPluginRoute } from "../packages/shared-contracts/dist/index.js";

const [pluginRoot, cwd, evidenceRoot] = process.argv.slice(2).map((value) => path.resolve(value));
await mkdir(evidenceRoot, { recursive: true });
const receipt = {
  hostProtocol: true,
  officialRequests: 0,
  completed: 0,
  reply: "",
  restoredReply: "",
};
let threadId;
for (const resume of [false, true]) {
  const input = new PassThrough(),
    output = new PassThrough(),
    diagnostic = new PassThrough();
  diagnostic.resume();
  const official = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      return true;
    },
  });
  official.stdin.on("data", () => receipt.officialRequests++);
  official.stdin.on("finish", () => {
    official.stdout.end();
    official.emit("exit", 0, null);
  });
  const messages = [];
  const waiters = [];
  const lines = readline.createInterface({ input: output });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    messages.push(message);
    for (const waiter of [...waiters])
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
  });
  const wait = (predicate) => {
    const found = messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => reject(new Error("Host protocol smoke timed out")), 90_000),
      };
      waiters.push(waiter);
    });
  };
  let nextId = 0;
  const request = async (method, params) => {
    const id = ++nextId;
    input.write(JSON.stringify({ id, method, params }) + "\n");
    const response = await wait((message) => message.id === id);
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    return response.result;
  };
  const host = new AppServerHost({
    stockCodexPath: "unused-synthetic-official",
    arguments: ["app-server"],
    defaultAgent: "codex",
    desktopInput: input,
    desktopOutput: output,
    diagnosticOutput: diagnostic,
    environment: {
      ...process.env,
      CODEXHOST_DATA_DIR: evidenceRoot,
      CODEX_HOME: path.join(evidenceRoot, "empty-codex-home"),
    },
    pluginRoots: [pluginRoot],
    spawnOfficial: () => official,
  });
  const running = host.run();
  try {
    const plugins = await request("codexhost/harness/plugins/list", {});
    assert.ok(plugins.plugins.some((plugin) => plugin.id === "cursor-cli"));
    const inspection = await request("codexhost/harness/inspect", { harnessId: "cursor-cli", cwd });
    assert.equal(inspection.status, "ready", JSON.stringify(inspection));
    if (!resume) {
      const model = inspection.catalog.models.find((model) => model.label === "composer-2.5");
      const started = await request("thread/start", {
        cwd,
        model: encodeHarnessPluginRoute({ harnessId: "cursor-cli", model: model.ref }),
      });
      threadId = started.thread.id;
    } else {
      const restored = await request("thread/resume", { threadId, cwd });
      const turns = restored.thread.turns;
      assert.equal(turns.length, 1);
      receipt.restoredReply = turns[0].items
        .filter((item) => item.type === "agentMessage")
        .map((item) => item.text)
        .join("");
      assert.equal(receipt.restoredReply.trim(), "CURSOR_HOST_PROTOCOL_OK");
      continue;
    }
    const started = await request("turn/start", {
      threadId,
      input: [
        { type: "text", text: "Reply exactly CURSOR_HOST_PROTOCOL_OK. Do not use any tools." },
      ],
    });
    const completed = await wait(
      (message) =>
        message.method === "turn/completed" && message.params?.turn?.id === started.turn.id,
    );
    assert.equal(completed.params.turn.status, "completed", JSON.stringify(completed));
    receipt.completed = messages.filter((message) => message.method === "turn/completed").length;
    const read = await request("thread/read", { threadId, includeTurns: true });
    receipt.reply = read.thread.turns[0].items
      .filter((item) => item.type === "agentMessage")
      .map((item) => item.text)
      .join("");
    assert.equal(receipt.reply.trim(), "CURSOR_HOST_PROTOCOL_OK");
  } finally {
    for (const waiter of waiters) clearTimeout(waiter.timer);
    input.end();
    await running;
    lines.close();
  }
}
assert.equal(receipt.officialRequests, 0);
assert.equal(receipt.completed, 1);
await writeFile(
  path.join(evidenceRoot, "protocol-receipt.json"),
  JSON.stringify({ ...receipt, threadId }, null, 2) + "\n",
);
console.log(JSON.stringify(receipt));
