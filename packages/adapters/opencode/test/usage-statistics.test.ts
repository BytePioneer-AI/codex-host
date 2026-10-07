import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createOpenCodeUsageStatistics, openCodeDatabasePath } from "../src/usage-statistics.js";

let home: string;
const signal = new AbortController().signal;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "opencode-usage-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const tokens = { input: 10, output: 3, reasoning: 2, cache: { read: 40, write: 5 } };

it("reads assistant messages, adding 1.x rows only until the v1-v2 migration completes", async () => {
  const file = openCodeDatabasePath({ XDG_DATA_HOME: home }) ?? "";
  await mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE kv (key TEXT, value TEXT);
    CREATE TABLE message (id TEXT, session_id TEXT, data TEXT);
    CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT);
    CREATE TABLE session_v2 (id TEXT, directory TEXT);
    INSERT INTO session_v2 VALUES ('s', '/work/opencode');
  `);
  const v2 = db.prepare("INSERT INTO session_message VALUES (?, 's', ?, ?)");
  v2.run(
    "m1",
    "assistant",
    JSON.stringify({
      model: { id: "glm-5.2", providerID: "zai" },
      tokens,
      time: { created: 1_000 },
    }),
  );
  v2.run(
    "m2",
    "assistant",
    JSON.stringify({ model: { id: "glm-5.2", providerID: "zai" }, time: { created: 2_000 } }),
  );
  v2.run("u1", "user", JSON.stringify({ text: "assistant" }));
  const v1 = db.prepare("INSERT INTO message VALUES (?, 's', ?)");
  v1.run(
    "m1",
    JSON.stringify({
      role: "assistant",
      modelID: "glm-5.2",
      providerID: "zai",
      tokens,
      time: { created: 1_000 },
    }),
  );
  v1.run(
    "old",
    JSON.stringify({
      role: "assistant",
      modelID: "glm-5.1",
      providerID: "zai",
      tokens,
      time: { created: 500 },
    }),
  );
  db.close();

  const capability = createOpenCodeUsageStatistics({ XDG_DATA_HOME: home });
  const [source] = await capability.listSources(signal);
  expect(source?.id).toBe(file);
  const before = await capability.readSource(file, signal);
  expect(before.map((entry) => entry.id).sort()).toEqual(["m1", "old"]);
  expect(before.find((entry) => entry.id === "m1")).toEqual({
    id: "m1",
    occurredAtMs: 1_000,
    model: "glm-5.2",
    inputTokens: 55,
    cachedInputTokens: 40,
    cacheWriteInputTokens: 5,
    outputTokens: 5,
    reasoningOutputTokens: 2,
    sessionId: "s",
    cwd: "/work/opencode",
  });

  const again = new DatabaseSync(file);
  again.prepare("INSERT INTO kv VALUES ('migration.v1-v2', ?)").run('{"phase":"completed"}');
  again.close();
  expect((await capability.readSource(file, signal)).map((entry) => entry.id)).toEqual(["m1"]);
});

it("has no source without a database", async () => {
  expect(await createOpenCodeUsageStatistics({ XDG_DATA_HOME: home }).listSources(signal)).toEqual(
    [],
  );
  expect(openCodeDatabasePath({ OPENCODE_DB: ":memory:" })).toBeNull();
});
