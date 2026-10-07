import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createGrokUsageStatistics } from "../src/usage-statistics.js";

let home: string;
const signal = new AbortController().signal;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "grok-usage-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function turn(prompt: string, atMs: number, usage: Record<string, unknown>) {
  return JSON.stringify({
    timestamp: Math.floor(atMs / 1000),
    method: "_x.ai/session/update",
    params: {
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: prompt,
        usage: { modelUsage: { "grok-4.7": usage } },
      },
      _meta: { agentTimestampMs: atMs },
    },
  });
}

const usage = {
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  cachedReadTokens: 60,
  cacheCreationTokens: 0,
  reasoningTokens: 5,
};

async function session(id: string, lines: string[], summary: object = {}): Promise<void> {
  const directory = path.join(home, "sessions", "%2Fwork", id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "updates.jsonl"), lines.join("\n"));
  await writeFile(path.join(directory, "summary.json"), JSON.stringify(summary));
}

it("reads turn usage by model and leaves out a fork's copies of its source's turns", async () => {
  await session("parent", [
    turn("p1", 1_000_000, usage),
    turn("p2", 2_000_000, { ...usage, cacheCreationTokens: 7 }),
  ]);
  await session("fork", [turn("p1", 2_500_000, usage), turn("p3", 4_000_000, usage)], {
    parent_session_id: "parent",
    created_at: new Date(3_000_000).toISOString(),
  });
  const capability = createGrokUsageStatistics({ GROK_HOME: home });
  const sources = await capability.listSources(signal);
  expect(sources.map((source) => path.basename(source.id))).toEqual([
    "updates.jsonl",
    "updates.jsonl",
  ]);
  const entries = (
    await Promise.all(sources.map((source) => capability.readSource(source.id, signal)))
  )
    .flat()
    .sort((a, b) => a.occurredAtMs - b.occurredAtMs);
  expect(entries).toEqual([
    {
      id: "p1:grok-4.7",
      occurredAtMs: 1_000_000,
      model: "grok-4.7",
      inputTokens: 100,
      cachedInputTokens: 60,
      cacheWriteInputTokens: 0,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      // The session folder and its URL-encoded parent folder.
      sessionId: "parent",
      cwd: "/work",
    },
    // A nonzero cache write has unverified semantics: cache counts stay unknown.
    {
      id: "p2:grok-4.7",
      occurredAtMs: 2_000_000,
      model: "grok-4.7",
      inputTokens: 100,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      sessionId: "parent",
      cwd: "/work",
    },
    expect.objectContaining({ id: "p3:grok-4.7", occurredAtMs: 4_000_000, sessionId: "fork" }),
  ]);
});
