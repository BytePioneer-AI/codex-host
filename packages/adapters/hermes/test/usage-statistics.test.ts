import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createHermesUsageStatistics, hermesStateDatabasePath } from "../src/usage-statistics.js";

let home: string;
const signal = new AbortController().signal;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "hermes-usage-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const COLUMNS = `(
  id TEXT, model TEXT, cwd TEXT, title TEXT, display_name TEXT,
  started_at REAL, last_activity_at REAL, api_call_count INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  cache_write_tokens INTEGER, reasoning_tokens INTEGER
)`;

async function writeDatabase(rows: string): Promise<string> {
  const file = hermesStateDatabasePath({ HERMES_HOME: home });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions ${COLUMNS}; INSERT INTO sessions VALUES ${rows};`);
  db.close();
  return file;
}

it("maps one session to one statistics entry with the unified input convention", async () => {
  const file = await writeDatabase(
    `('s1', 'glm-5.2', '/work/hermes', '排查用量', NULL,
      1.5, 9.5, 12, 100, 30, 400, 20, 8)`,
  );
  const capability = createHermesUsageStatistics({ HERMES_HOME: home });
  const [source] = await capability.listSources(signal);
  expect(source?.id).toBe(file);
  expect(source?.fingerprint).toBeTruthy();
  expect(await capability.readSource(file, signal)).toEqual([
    {
      id: "s1",
      occurredAtMs: 9_500,
      model: "glm-5.2",
      // Hermes' input bucket excludes cache; the entry recombines it.
      inputTokens: 520,
      cachedInputTokens: 400,
      cacheWriteInputTokens: 20,
      outputTokens: 30,
      reasoningOutputTokens: 8,
      sessionId: "s1",
      cwd: "/work/hermes",
      sessionTitle: "排查用量",
    },
  ]);
});

it("skips sessions without any usage and falls back for metadata", async () => {
  const file = await writeDatabase(
    `('live', 'glm-5-turbo', NULL, NULL, 'display name', 5, NULL, 3, 10, 4, 0, 0, 0),
     ('empty', 'glm-5-turbo', '/work', 'no calls', NULL, 5, 6, 0, 0, 0, 0, 0, 0),
     ('nocalls', NULL, NULL, NULL, NULL, 7, 8, 0, 50, 5, 0, 0, 0)`,
  );
  const capability = createHermesUsageStatistics({ HERMES_HOME: home });
  const [source] = await capability.listSources(signal);
  expect(source?.id).toBe(file);
  const entries = await capability.readSource(file, signal);
  // Rows with tokens but a zero call count are real spend; only all-zero rows are noise.
  expect(entries.map((entry) => entry.id).sort()).toEqual(["live", "nocalls"]);
  expect(entries.find((entry) => entry.id === "nocalls")).toEqual({
    id: "nocalls",
    occurredAtMs: 8_000,
    inputTokens: 50,
    outputTokens: 5,
    sessionId: "nocalls",
  });
});

it("has no source without a database and tracks database changes", async () => {
  const capability = createHermesUsageStatistics({ HERMES_HOME: home });
  expect(await capability.listSources(signal)).toEqual([]);
  const file = await writeDatabase(
    `('s1', 'glm-5.2', '/work', NULL, NULL, 1, 2, 1, 10, 3, 0, 0, 0)`,
  );
  const [before] = await capability.listSources(signal);
  expect(before?.id).toBe(file);
  await writeFile(file, "changed");
  const [after] = await capability.listSources(signal);
  expect(after?.fingerprint).not.toBe(before?.fingerprint);
});

it("reports an unreadable database instead of silently hiding usage", async () => {
  const file = hermesStateDatabasePath({ HERMES_HOME: home });
  await writeFile(file, "this is not a database");
  const capability = createHermesUsageStatistics({ HERMES_HOME: home });
  const [source] = await capability.listSources(signal);
  await expect(capability.readSource(source?.id ?? file, signal)).rejects.toThrow();
});
