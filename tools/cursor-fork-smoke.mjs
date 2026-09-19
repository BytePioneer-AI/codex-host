// Opt-in real Cursor smoke: uses the existing native login and isolated session stores.
// node tools/cursor-fork-smoke.mjs [dedicated-workspace]
// Use --resume-fixture <root> to retry a failed fixture that still has only its source session.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CursorAdapter } from "../packages/adapters/cursor-cli/dist/index.js";
import { cursorConfigDirectory } from "../packages/adapters/cursor-cli/dist/native-history.js";
import { loadHarnessPlugins } from "../packages/host-runtime/dist/index.js";

const retry = process.argv[2] === "--resume-fixture";
const root = retry
  ? path.resolve(process.argv[3])
  : await mkdtemp(path.join(os.tmpdir(), "cursor-native-fork-smoke-"));
const config = path.join(root, "config"),
  cwd = path.resolve((retry ? undefined : process.argv[2]) ?? path.join(root, "workspace"));
await mkdir(config, { mode: 0o700, recursive: true });
await mkdir(cwd, { recursive: true });
const configFile = path.join(config, "cli-config.json");
try {
  await copyFile(path.join(cursorConfigDirectory(process.env), "cli-config.json"), configFile);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await writeFile(path.join(cwd, "marker.txt"), "CURSOR_NATIVE_FORK_918\n");
const environment = {
  ...process.env,
  CURSOR_CONFIG_DIR: config,
  CURSOR_DATA_DIR: path.join(root, "data"),
};
const pluginRoot = process.env.CURSOR_FORK_PLUGIN_ROOT;
const diagnostics = [];
const registry = pluginRoot
  ? await loadHarnessPlugins({
      roots: [pluginRoot],
      context: { environment, platform: process.platform, managedRemoteHost: false },
      warmup: false,
      diagnose: (value) => diagnostics.push(value),
    })
  : undefined;
assert.deepEqual(diagnostics, []);
const adapter = registry
  ? registry.adapters.get("cursor-cli")
  : new CursorAdapter({ environment, timeoutMs: 90_000 });
assert.ok(adapter);
const report = { root, cwd, pluginLoaded: Boolean(registry), pass: false };
const collections = [];
const attach = (session) => {
  const pending = new Map();
  let messages = "";
  const pump = (async () => {
    for await (const output of session.outputs) {
      if (
        output.kind === "event" &&
        output.event.type === "item.updated" &&
        output.event.update.type === "text.append"
      ) {
        messages = (messages + output.event.update.text).slice(-4000);
      }
      if (output.kind === "interaction") {
        assert.equal(
          output.interaction.type,
          "approval",
          "Unexpected interaction in fixed smoke prompt",
        );
        const action = output.interaction.actions.find((a) => a.effect === "deny");
        assert.ok(action);
        await session.execute({
          type: "interaction.respond",
          interactionId: output.interaction.interactionId,
          response: { type: "approval", actionId: action.id },
        });
      }
      if (output.kind === "event" && output.event.type === "turn.completed") {
        pending.get(output.event.turnId)?.(output.event);
      }
    }
  })();
  collections.push(pump);
  return async (text) => {
    const turnId = randomUUID();
    let timer;
    const done = new Promise((resolve, reject) => {
      pending.set(turnId, resolve);
      timer = setTimeout(() => reject(new Error("Native smoke turn timed out")), 120_000);
    });
    try {
      const accepted = await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text }],
      });
      assert.equal(accepted.ok, true, JSON.stringify(accepted));
      const terminal = await done;
      if (terminal.outcome.status !== "succeeded") report.failedTurnOutput = messages;
      assert.equal(terminal.outcome.status, "succeeded", JSON.stringify(terminal));
      return terminal;
    } finally {
      clearTimeout(timer);
      pending.delete(turnId);
    }
  };
};
const snapshot = async (session) => {
  const result = await session.readSnapshot();
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const turnsContent = (snapshot) =>
  snapshot.turns.map(({ input, items, outcome }) => ({ input, items, outcome }));
try {
  const existing = retry ? await readdir(path.join(config, "acp-sessions")) : [];
  if (retry) assert.equal(existing.length, 1, "Retry requires only the source session");
  let opened = await adapter.open(
    retry
      ? {
          kind: "resume",
          cwd,
          nativeRef: { harnessId: "cursor-cli", nativeSessionId: existing[0], formatVersion: 1 },
        }
      : { kind: "create", cwd },
  );
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const source = opened.value;
  const run = attach(source);
  if (!retry) {
    await run(
      "Read marker.txt with your native Read tool. Then invoke your native Task tool with one generalPurpose subagent to read marker.txt and report its exact contents. Wait for the child. Finally repeat the exact marker. Do not modify files or run shell commands.",
    );
    await run("Reply exactly SECOND_TURN. Use no tools.");
  }
  const before = await snapshot(source);
  assert.equal(before.turns.length, 2);
  const tasks = before.turns[0].items.filter(({ item }) => item.type === "subagentDelegation");
  report.sourceSubagentCount = tasks.length;
  assert.ok(tasks.length, "Native model did not execute the required Task control");
  const sourceRef = source.initialState.nativeRef;
  const sourceDb = path.join(config, "acp-sessions", sourceRef.nativeSessionId, "store.db");
  const sourceHash = createHash("sha256")
    .update(await readFile(sourceDb))
    .digest("hex");
  // A historical checkpoint retains exactly one turn, including its native tool records.
  opened = await adapter.open({
    kind: "fork",
    sourceRef,
    cwd,
    checkpoint: before.turns[0].checkpoint,
  });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const historical = opened.value;
  assert.deepEqual(
    turnsContent(await snapshot(historical)),
    turnsContent({ turns: before.turns.slice(0, 1) }),
  );
  report.historicalForkExactPrefix = true;
  const historicalRef = historical.initialState.nativeRef;
  await attach(historical)(
    "What exact marker did the subagent read? Reply with that marker only. Do not use tools.",
  );
  const continuedHistory = await snapshot(historical);
  assert.equal(continuedHistory.turns.length, 2);
  assert.ok(
    continuedHistory.turns
      .at(-1)
      .items.some(
        ({ item }) => item.type === "agentMessage" && item.text.trim() === "CURSOR_NATIVE_FORK_918",
      ),
  );
  report.historicalContinuationRemembersMarker = true;
  opened = await adapter.open({ kind: "rollbackLastTurn", sourceRef: historicalRef, cwd });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const revised = opened.value;
  assert.deepEqual(
    turnsContent(await snapshot(revised)),
    turnsContent({ turns: before.turns.slice(0, 1) }),
  );
  report.rollbackExactPrefix = true;
  opened = await adapter.open({
    kind: "rollbackLastTurn",
    sourceRef: revised.initialState.nativeRef,
    cwd,
  });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const empty = opened.value;
  assert.equal((await snapshot(empty)).turns.length, 0);
  report.singleTurnRollbackIsEmpty = true;
  const noHistory = await adapter.open({
    kind: "rollbackLastTurn",
    sourceRef: empty.initialState.nativeRef,
    cwd,
  });
  assert.equal(noHistory.ok, false);
  assert.equal(noHistory.error.code, "checkpointNotFound");
  const emptyRef = empty.initialState.nativeRef;
  await attach(empty)("Reply exactly EDITED_FIRST_TURN. Use no tools.");
  await empty.close();
  opened = await adapter.open({ kind: "resume", nativeRef: emptyRef, cwd });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const edited = await snapshot(opened.value);
  assert.equal(edited.turns.length, 1);
  assert.ok(
    edited.turns[0].items.some(
      ({ item }) => item.type === "agentMessage" && item.text.trim() === "EDITED_FIRST_TURN",
    ),
  );
  report.revisedFirstTurnSurvivesReload = true;
  await opened.value.close();
  await revised.close();
  await historical.close();
  opened = await adapter.open({
    kind: "fork",
    sourceRef,
    cwd,
    checkpoint: before.turns.at(-1).checkpoint,
  });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const fork = opened.value;
  const forkRef = fork.initialState.nativeRef;
  assert.notEqual(forkRef.nativeSessionId, sourceRef.nativeSessionId);
  const forked = await snapshot(fork);
  assert.deepEqual(turnsContent(forked), turnsContent(before));
  report.historyIncludingToolsAndSubagentMatches = true;
  const childId = tasks.at(-1).item.subagents[0].nativeSubagentId;
  const child = await adapter.subagents.readSnapshot({
    parent: forkRef,
    nativeSubagentId: childId,
    cwd,
  });
  assert.equal(child.ok, true, JSON.stringify(child));
  const originalChild = await adapter.subagents.readSnapshot({
    parent: sourceRef,
    nativeSubagentId: childId,
    cwd,
  });
  assert.equal(originalChild.ok, true, JSON.stringify(originalChild));
  assert.deepEqual(turnsContent(child.value), turnsContent(originalChild.value));
  report.inheritedSubagentRecordMatches = true;
  const continueFork = attach(fork);
  await continueFork(
    "What exact marker did you and the subagent read earlier? Reply only with that marker. Do not use tools.",
  );
  const continued = await snapshot(fork);
  assert.ok(
    continued.turns
      .at(-1)
      .items.some(
        ({ item }) => item.type === "agentMessage" && item.text.trim() === "CURSOR_NATIVE_FORK_918",
      ),
  );
  report.continuationRemembersMarker = true;
  await continueFork(
    "Invoke your native Task tool with one generalPurpose subagent to read marker.txt and report the marker. Wait for completion. Do not modify files or run shell commands.",
  );
  const withChild = await snapshot(fork);
  const newTask = withChild.turns
    .at(-1)
    .items.filter(({ item }) => item.type === "subagentDelegation")
    .at(-1);
  assert.ok(newTask, "Native model did not create a child after Fork");
  const newChild = await adapter.subagents.readSnapshot({
    parent: forkRef,
    nativeSubagentId: newTask.item.subagents[0].nativeSubagentId,
    cwd,
  });
  assert.equal(newChild.ok, true, JSON.stringify(newChild));
  assert.equal(newChild.value.turns[0].outcome.status, "succeeded");
  assert.equal(newChild.value.turns[0].nativeTurnRef.nativeSessionId, forkRef.nativeSessionId);
  report.newSubagentRecordUnderFork = true;
  await fork.close();
  opened = await adapter.open({ kind: "resume", cwd, nativeRef: forkRef });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const resumed = await snapshot(opened.value);
  assert.equal(resumed.turns.length, 4);
  report.freshProcessRestoresFourTurns = true;
  assert.equal(
    createHash("sha256")
      .update(await readFile(sourceDb))
      .digest("hex"),
    sourceHash,
  );
  report.sourceDatabaseUnchanged = true;
  assert.deepEqual(
    (await readdir(path.join(config, "acp-sessions"))).sort(),
    [
      sourceRef.nativeSessionId,
      forkRef.nativeSessionId,
      historicalRef.nativeSessionId,
      revised.initialState.nativeRef.nativeSessionId,
      emptyRef.nativeSessionId,
    ].sort(),
  );
  report.onlySourceAndRequestedDerivedSessions = true;
  assert.equal(await readFile(path.join(cwd, "marker.txt"), "utf8"), "CURSOR_NATIVE_FORK_918\n");
  report.workspaceFileUnchanged = true;
  report.pass = true;
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  await adapter.close();
  await Promise.allSettled(collections);
  await rm(configFile, { force: true });
  await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
