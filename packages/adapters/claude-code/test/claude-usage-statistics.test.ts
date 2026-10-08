import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createClaudeUsageStatistics } from "../src/claude-usage-statistics.js";

let home: string;
const signal = new AbortController().signal;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "claude-usage-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function assistant(id: string, timestamp: string, output: number, extra: object = {}) {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    ...extra,
    message: {
      id,
      model: "claude-sonnet-4-5",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_creation: { ephemeral_1h_input_tokens: 5 },
        output_tokens: output,
      },
    },
  });
}

it("reads main and subagent transcripts, one entry per message dated by its first line", async () => {
  const project = path.join(home, "projects", "-work");
  await mkdir(path.join(project, "s1", "subagents"), { recursive: true });
  await writeFile(
    path.join(project, "s1.jsonl"),
    [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      assistant("m1", "2026-10-05T01:00:00.000Z", 3),
      assistant("m1", "2026-10-05T01:00:05.000Z", 3),
      assistant("synthetic", "2026-10-05T01:00:06.000Z", 0).replace(
        "claude-sonnet-4-5",
        "<synthetic>",
      ),
    ].join("\n"),
  );
  await writeFile(
    path.join(project, "s1", "subagents", "agent-a.jsonl"),
    assistant("m2", "2026-10-05T02:00:00.000Z", 7, { isSidechain: true }),
  );
  const capability = createClaudeUsageStatistics({ CLAUDE_CONFIG_DIR: home });
  const sources = await capability.listSources(signal);
  const entries = (
    await Promise.all(sources.map((source) => capability.readSource(source.id, signal)))
  ).flat();
  expect(entries.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
    {
      id: "m1",
      occurredAtMs: Date.parse("2026-10-05T01:00:00.000Z"),
      model: "claude-sonnet-4-5",
      inputTokens: 130,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 20,
      cacheWrite1hInputTokens: 5,
      outputTokens: 3,
    },
    expect.objectContaining({ id: "m2", outputTokens: 7 }),
  ]);
});

it("attributes requests to the transcript's session and working directory", async () => {
  const project = path.join(home, "projects", "-work-app");
  await mkdir(project, { recursive: true });
  await writeFile(
    path.join(project, "s9.jsonl"),
    assistant("m9", "2026-10-05T01:00:00.000Z", 3, { sessionId: "s9", cwd: "/work/app" }),
  );
  // An older line without the fields still counts, unattributed.
  await writeFile(path.join(project, "bare.jsonl"), assistant("b1", "2026-10-05T01:00:00.000Z", 1));
  const capability = createClaudeUsageStatistics({ CLAUDE_CONFIG_DIR: home });
  const read = (name: string) => capability.readSource(path.join(project, name), signal);
  expect(await read("s9.jsonl")).toEqual([
    expect.objectContaining({ id: "m9", sessionId: "s9", cwd: "/work/app" }),
  ]);
  const [bare] = await read("bare.jsonl");
  expect(bare).not.toHaveProperty("sessionId");
  expect(bare).not.toHaveProperty("cwd");
});

it("names a session from custom-title, else the first user prompt", async () => {
  const project = path.join(home, "projects", "-work-app");
  await mkdir(project, { recursive: true });
  await writeFile(
    path.join(project, "named.jsonl"),
    [
      JSON.stringify({
        type: "user",
        sessionId: "named",
        cwd: "/work/app",
        message: { role: "user", content: "first prompt" },
      }),
      JSON.stringify({ type: "custom-title", customTitle: " Renamed chat ", sessionId: "named" }),
      assistant("m1", "2026-10-05T01:00:00.000Z", 3, { sessionId: "named", cwd: "/work/app" }),
    ].join("\n"),
  );
  const capability = createClaudeUsageStatistics({ CLAUDE_CONFIG_DIR: home });
  expect(await capability.readSource(path.join(project, "named.jsonl"), signal)).toEqual([
    expect.objectContaining({ sessionId: "named", sessionTitle: "Renamed chat" }),
  ]);
});
