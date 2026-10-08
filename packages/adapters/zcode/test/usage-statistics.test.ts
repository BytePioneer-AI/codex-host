import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createZcodeUsageStatistics, zcodeDatabasePath } from "../src/usage-statistics.js";

let home: string;
const signal = new AbortController().signal;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "zcode-usage-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

it("reads assistant messages with AI SDK totals and skips placeholders and unknown conventions", async () => {
  const file = zcodeDatabasePath({ HOME: home });
  await mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE message (id TEXT, session_id TEXT, data TEXT);
    CREATE TABLE session (id TEXT, directory TEXT);
    INSERT INTO session VALUES ('s', '/work/zcode');
  `);
  const insert = db.prepare("INSERT INTO message VALUES (?, 's', ?)");
  const message = (tokens: object, extra: object = {}) =>
    JSON.stringify({
      role: "assistant",
      modelId: "GLM-5.3",
      providerID: "builtin:zai",
      time: { created: 7_000, completed: 8_000 },
      tokens,
      ...extra,
    });
  insert.run(
    "ok",
    message({ total: 130, input: 100, output: 30, reasoning: 5, cache: { read: 60, write: 0 } }),
  );
  insert.run(
    "placeholder",
    message(
      { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      { error: { name: "Cancelled" } },
    ),
  );
  insert.run(
    "unknown",
    message({ total: 999, input: 100, output: 30, cache: { read: 0, write: 0 } }),
  );
  insert.run("user", JSON.stringify({ role: "user", time: { created: 1 } }));
  db.close();

  const capability = createZcodeUsageStatistics({ HOME: home });
  const [source] = await capability.listSources(signal);
  expect(await capability.readSource(source?.id ?? "", signal)).toEqual([
    {
      id: "ok",
      occurredAtMs: 7_000,
      model: "GLM-5.3",
      inputTokens: 100,
      cachedInputTokens: 60,
      cacheWriteInputTokens: 0,
      outputTokens: 30,
      reasoningOutputTokens: 5,
      sessionId: "s",
      cwd: "/work/zcode",
    },
  ]);
});
