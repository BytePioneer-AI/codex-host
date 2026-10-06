// Real Harness Model selection through the production mobile facade, isolated from Desktop.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { decodeCreateRoute } from "@codexhost/protocol-core";
import { startNativeServer } from "./native-session.mjs";
import { startRealHost } from "./real-host.mjs";
const [harness, report] = process.argv.slice(2);
if (!["opencode", "claude-code"].includes(harness) || !report)
  throw new Error("Pass Harness and report path");
const home = await mkdtemp("/tmp/ch-real-model-native-");
const catalog = path.resolve(
  "build/mobile-codex/macos-arm64/source-33eee16bc75d631c3949365de25abe76c64e7aeb59d8b2cfc42d9b52fecb6432/codex-rs/models-manager/models.json",
);
await writeFile(
  path.join(home, "config.toml"),
  `model_catalog_json = ${JSON.stringify(catalog)}\ncli_auth_credentials_store = "file"\n`,
  { mode: 0o600 },
);
let native;
let host;
const connect = {
  onReady: async (socket) => {
    native = await startNativeServer({
      binary: path.resolve("packages/host-runtime/dist/mobile-codex/bin/codex"),
      home,
      hostSocket: socket,
      cliMode: true,
      environment: {
        HOME: home,
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
      },
    });
  },
  createOfficialConnection: () => native.connect(),
};
try {
  host = await startRealHost({ harness, ...connect });
  const current = await host.desktop.request("codexhost/thread/inspect", {
    threadId: host.threadId,
  });
  const entries = [];
  let cursor = null;
  do {
    const page = await host.desktop.request("model/list", { cursor, limit: 200 });
    entries.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  const candidates = entries.filter((entry) => {
    const route = decodeCreateRoute({
      id: 0,
      method: "thread/start",
      params: { model: entry.model },
    });
    return route?.harnessId === harness && route.model?.id !== current.effectiveModel?.id;
  });
  const chosen =
    candidates.find((entry) => /haiku/i.test(entry.displayName)) ??
    candidates.find((entry) => /sonnet/i.test(entry.displayName)) ??
    candidates[0];
  assert(chosen, "At least one different real Model in this Harness profile is required");
  const expected = decodeCreateRoute({
    id: 0,
    method: "thread/start",
    params: { model: chosen.model },
  }).model;
  const turn = await host.desktop.request("turn/start", {
    threadId: host.threadId,
    model: chosen.model,
    effort: chosen.defaultReasoningEffort,
    input: [
      { type: "text", text: "不要调用工具，不要读取或修改任何文件，只回复 REAL_MODEL_SWITCH_OK。" },
    ],
  });
  const deadline = Date.now() + 120000;
  let completed;
  while (Date.now() < deadline) {
    completed = host.desktop.messages.find(
      (message) => message.method === "turn/completed" && message.params.turn.id === turn.turn.id,
    )?.params.turn;
    if (completed) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(completed?.status, "completed");
  assert(
    completed.items.some(
      (item) => item.type === "agentMessage" && item.text.includes("REAL_MODEL_SWITCH_OK"),
    ),
  );
  const state = await host.desktop.request("codexhost/thread/inspect", { threadId: host.threadId });
  assert.deepEqual(state.effectiveModel, expected);
  const identity = { dataDirectory: host.directory, threadId: host.threadId };
  await host.close();
  host = undefined;
  await native.close();
  native = undefined;
  host = await startRealHost({ harness, ...identity, ...connect });
  const restored = await host.desktop.request("thread/resume", { threadId: identity.threadId });
  assert.equal(restored.model, chosen.model);
  const restoredState = await host.desktop.request("codexhost/thread/inspect", {
    threadId: identity.threadId,
  });
  assert.deepEqual(restoredState.effectiveModel, expected);
  const result = {
    passed: true,
    harness,
    displayName: chosen.displayName,
    actualModel: expected,
    realTurnCompleted: true,
    ownerRestartRestoredModel: true,
    realPhone: false,
  };
  await writeFile(report, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally {
  await host?.close();
  await native?.close();
  await rm(home, { recursive: true, force: true });
}
