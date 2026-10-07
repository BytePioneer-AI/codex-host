import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createPiUsageStatistics } from "../src/pi-usage-statistics.js";

let home: string;
const signal = new AbortController().signal;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "pi-usage-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function message(responseId: string | null, timestamp: number, output: number) {
  return JSON.stringify({
    type: "message",
    timestamp: new Date(timestamp).toISOString(),
    message: {
      role: "assistant",
      model: "deepseek-flash",
      ...(responseId ? { responseId } : {}),
      timestamp,
      usage: { input: 10, output, cacheRead: 30, cacheWrite: 0 },
    },
  });
}

it("reads session and subagent files; a fork repeats its parent's request IDs", async () => {
  const project = path.join(home, "sessions", "--work--");
  await mkdir(path.join(project, "s1", "agent", "run-0"), { recursive: true });
  const parent = [
    JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/work" }),
    message("resp-1", 1_000, 5),
    message(null, 2_000, 6),
    JSON.stringify({ type: "message", message: { role: "user", content: "assistant" } }),
  ];
  await writeFile(path.join(project, "s1.jsonl"), parent.join("\n"));
  await writeFile(
    path.join(project, "s2.jsonl"),
    [
      JSON.stringify({ type: "session", version: 3, id: "s2", parentSession: "s1" }),
      ...parent.slice(1),
      message("resp-3", 3_000, 7),
    ].join("\n"),
  );
  await writeFile(
    path.join(project, "s1", "agent", "run-0", "session.jsonl"),
    message("resp-4", 4_000, 8),
  );
  const capability = createPiUsageStatistics({ PI_CODING_AGENT_DIR: home });
  const sources = await capability.listSources(signal);
  expect(sources).toHaveLength(3);
  const ids = (await Promise.all(sources.map((source) => capability.readSource(source.id, signal))))
    .flat()
    .map((entry) => `${entry.id}@${entry.occurredAtMs}:${entry.inputTokens}/${entry.outputTokens}`);
  expect(ids.sort()).toEqual([
    "resp-1@1000:40/5",
    "resp-1@1000:40/5",
    "resp-3@3000:40/7",
    "resp-4@4000:40/8",
    "t2000@2000:40/6",
    "t2000@2000:40/6",
  ]);
  // The header names each file's session; a header without cwd leaves it out.
  const [first] = await capability.readSource(path.join(project, "s1.jsonl"), signal);
  expect(first).toMatchObject({ sessionId: "s1", cwd: "/work" });
  const [copy] = await capability.readSource(path.join(project, "s2.jsonl"), signal);
  expect(copy).toMatchObject({ sessionId: "s2" });
  expect(copy).not.toHaveProperty("cwd");
});
