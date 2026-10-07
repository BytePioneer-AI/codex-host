import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createOmpUsageStatistics } from "../src/omp-usage-statistics.js";

let home: string;
const signal = new AbortController().signal;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "omp-usage-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

it("reads OMP session files with a title line and subagents in the artifacts folder", async () => {
  const project = path.join(home, "sessions", "-work");
  await mkdir(path.join(project, "2026_s1"), { recursive: true });
  const assistant = (responseId: string, timestamp: number) =>
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        model: "glm-5.2",
        responseId,
        timestamp,
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      },
    });
  await writeFile(
    path.join(project, "2026_s1.jsonl"),
    [
      JSON.stringify({ type: "title", title: "A session" }),
      JSON.stringify({ type: "session", id: "s1", cwd: "/work/omp" }),
      assistant("r1", 5_000),
    ].join("\n"),
  );
  await writeFile(path.join(project, "2026_s1", "Inspector.jsonl"), assistant("r2", 6_000));
  const capability = createOmpUsageStatistics({ PI_CODING_AGENT_DIR: home });
  const entries = (
    await Promise.all(
      (await capability.listSources(signal)).map((source) =>
        capability.readSource(source.id, signal),
      ),
    )
  ).flat();
  expect(entries.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
    {
      id: "r1",
      occurredAtMs: 5_000,
      model: "glm-5.2",
      inputTokens: 8,
      cachedInputTokens: 3,
      cacheWriteInputTokens: 4,
      outputTokens: 2,
      // The header after OMP's title line names the session and where it ran.
      sessionId: "s1",
      cwd: "/work/omp",
    },
    expect.objectContaining({ id: "r2", occurredAtMs: 6_000 }),
  ]);
  // A subagent file without a header is counted, unattributed.
  expect(entries.find((entry) => entry.id === "r2")).not.toHaveProperty("sessionId");
});
