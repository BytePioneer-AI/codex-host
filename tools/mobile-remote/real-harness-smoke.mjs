// Real local acceptance, using a fresh validation store and its own saved thread.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { startRealHost } from "./real-host.mjs";
import { connectHost } from "./synthetic-host.mjs";
const harness = process.argv[2] ?? "opencode";
const report = process.argv[3];
if (!report)
  throw new Error("Usage: real-harness-smoke.mjs opencode|claude-code /path/report.json");
let host = await startRealHost({ harness });
let mobile;
const identity = { directory: host.directory, threadId: host.threadId };
async function waitTurn(client, id) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    // Wait for the protocol completion event; polling snapshots during native
    // identity persistence correctly yields the existing concurrent-read error.
    const completed = client.messages.find(
      (message) =>
        message.method === "turn/completed" &&
        message.params.threadId === identity.threadId &&
        message.params.turn.id === id,
    );
    if (completed) return completed.params.turn;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Real validation turn timed out");
}
try {
  mobile = await connectHost(host.socketPath, "independent-mobile-client", 30000);
  const listed = await mobile.request("thread/list", { modelProviders: ["codexhost"] });
  assert(
    listed.data.some((thread) => thread.id === identity.threadId),
    "Unsent live Session must be discoverable",
  );
  await mobile.request("thread/resume", { threadId: identity.threadId });
  const first = await mobile.request("turn/start", {
    threadId: identity.threadId,
    input: [{ type: "text", text: "独立取消测试，不要使用工具，逐行输出 1 到 1000。" }],
  });
  await host.desktop.request("turn/interrupt", {
    threadId: identity.threadId,
    turnId: first.turn.id,
  });
  assert.equal((await waitTurn(host.desktop, first.turn.id)).status, "interrupted");
  const second = await mobile.request("turn/start", {
    threadId: identity.threadId,
    input: [{ type: "text", text: "不要调用工具、读取或修改文件，只回复 REAL_AFTER_CANCEL_OK。" }],
  });
  const complete = await waitTurn(host.desktop, second.turn.id);
  assert.equal(complete.status, "completed");
  assert(
    complete.items.some(
      (item) => item.type === "agentMessage" && item.text.trim() === "REAL_AFTER_CANCEL_OK",
    ),
  );
  await mobile.close();
  mobile = undefined;
  await host.close();
  host = undefined;
  host = await startRealHost({
    harness,
    dataDirectory: identity.directory,
    threadId: identity.threadId,
  });
  const history = await host.desktop.request("thread/read", {
    threadId: identity.threadId,
    includeTurns: true,
  });
  assert(
    history.thread.turns.some((turn) => turn.id === second.turn.id && turn.status === "completed"),
  );
  const result = {
    passed: true,
    harness,
    ...identity,
    independentClients: true,
    crossClientInterrupt: true,
    turnAfterCancellation: true,
    restoredNativeHistory: true,
  };
  await writeFile(report, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally {
  await mobile?.close();
  await host?.close();
}
