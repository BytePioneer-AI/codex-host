import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { CODEBUDDY_RUNTIME_PROFILE } from "../src/common.js";
import { createCodeBuddyUsageStatistics } from "../src/usage-statistics.js";

let home: string;
const signal = new AbortController().signal;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "codebuddy-usage-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function row(messageId: string, timestamp: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "message",
    timestamp,
    providerData: {
      messageId,
      model: "deepseek-v4.1-flash",
      ...extra,
      rawUsage: {
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 60 },
        prompt_cache_write_tokens: 10,
        completion_tokens: 20,
        completion_thinking_tokens: 5,
      },
    },
  });
}

it("reads every message once per transcript, subagents included, dated by the first row", async () => {
  const project = path.join(home, "projects", "work");
  await mkdir(path.join(project, "s1", "subagents"), { recursive: true });
  await writeFile(
    path.join(project, "s1.jsonl"),
    [
      row("m1", 1_000),
      JSON.stringify({
        type: "function_call",
        timestamp: 1_500,
        providerData: {
          messageId: "m1",
          rawUsage: {
            prompt_tokens: 100,
            prompt_tokens_details: { cached_tokens: 60 },
            prompt_cache_write_tokens: 10,
            completion_tokens: 20,
          },
          model: "deepseek-v4.1-flash",
        },
      }),
      row("unverified", 2_000, {}).replace(
        '"completion_tokens"',
        '"cache_read_input_tokens":3,"completion_tokens"',
      ),
    ].join("\n"),
  );
  await writeFile(
    path.join(project, "s1", "subagents", "agent-1.jsonl"),
    row("m2", 3_000, { isSubAgent: true }),
  );
  const capability = createCodeBuddyUsageStatistics(
    { CODEBUDDY_CONFIG_DIR: home, HOME: home },
    { ...CODEBUDDY_RUNTIME_PROFILE, configDirectoryEnvironmentVariables: ["CODEBUDDY_CONFIG_DIR"] },
  );
  const entries = (
    await Promise.all(
      (await capability.listSources(signal)).map((source) =>
        capability.readSource(source.id, signal),
      ),
    )
  ).flat();
  expect(entries.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
    expect.objectContaining({
      id: "m1",
      occurredAtMs: 1_000,
      inputTokens: 100,
      cachedInputTokens: 60,
      cacheWriteInputTokens: 10,
      outputTokens: 20,
    }),
    expect.objectContaining({ id: "m2", occurredAtMs: 3_000, reasoningOutputTokens: 5 }),
  ]);
});

it("reads fractional and zero native credits once per request, without inventing missing credits", async () => {
  const file = path.join(home, "credits.jsonl");
  const values = [1.25, 0, undefined, -1, "2"];
  const rows = values.map((credit, index) => {
    const value = JSON.parse(row(String(index), 1_000));
    value.providerData.rawUsage.credit = credit;
    return JSON.stringify(value);
  });
  await writeFile(file, [...rows, rows[0]].join("\n"));
  const capability = createCodeBuddyUsageStatistics({ HOME: home }, CODEBUDDY_RUNTIME_PROFILE);
  const entries = await capability.readSource(file, signal);
  expect(entries.map((entry) => entry.credits)).toEqual([1.25, 0, undefined, undefined, undefined]);
  expect(entries).toHaveLength(5);
});

it("attributes messages to the rows' session and working directory", async () => {
  const project = path.join(home, "projects", "work");
  await mkdir(project, { recursive: true });
  const attributed = { ...JSON.parse(row("m1", 1_000)), sessionId: "s1", cwd: "/work/buddy" };
  await writeFile(path.join(project, "s1.jsonl"), JSON.stringify(attributed));
  const capability = createCodeBuddyUsageStatistics(
    { CODEBUDDY_CONFIG_DIR: home, HOME: home },
    { ...CODEBUDDY_RUNTIME_PROFILE, configDirectoryEnvironmentVariables: ["CODEBUDDY_CONFIG_DIR"] },
  );
  expect(await capability.readSource(path.join(project, "s1.jsonl"), signal)).toEqual([
    expect.objectContaining({ id: "m1", sessionId: "s1", cwd: "/work/buddy" }),
  ]);
});
