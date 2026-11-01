import { appendFile, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { HarnessUsageSourceChangedError } from "@codexhost/harness-adapter/usage-statistics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AntigravityAdapter } from "../src/antigravity-adapter.js";
import { createAntigravityUsageStatistics } from "../src/usage-statistics.js";

let home: string;
const signal = new AbortController().signal;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "agy-usage-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** agy resolves its store against USERPROFILE on Windows and HOME elsewhere. */
const environment = () => ({ HOME: home, USERPROFILE: home });

function brain(...segments: string[]): string {
  return path.join(home, ".gemini", "antigravity-cli", "brain", ...segments);
}

/** Step records shaped like Antigravity CLI 1.4.6 transcripts; text fields are placeholders. */
function step(index: number, type: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    step_index: index,
    source: type === "USER_INPUT" ? "USER_EXPLICIT" : "MODEL",
    type,
    status: "DONE",
    created_at: "2026-09-01T08:00:00Z",
    ...fields,
  });
}

function request(index: number, createdAt: string, usage: Record<string, number>): string {
  return step(index, "PLANNER_RESPONSE", {
    created_at: createdAt,
    content: "placeholder reply",
    ...usage,
  });
}

async function transcript(
  conversationId: string,
  lines: string[],
  file = "transcript.jsonl",
): Promise<string> {
  const target = path.join(brain(conversationId, ".system_generated", "logs"), file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${lines.join("\n")}\n`);
  return target;
}

describe("Antigravity usage statistics", () => {
  it("reads one entry per model request, with input including cache reads", async () => {
    const lines = [
      step(0, "USER_INPUT", { content: "placeholder prompt" }),
      request(1, "2026-09-01T08:00:01Z", {
        input_tokens: 7_000,
        cache_read_tokens: 0,
        output_tokens: 300,
      }),
      step(2, "GENERIC", { content: "placeholder tool output" }),
      // The next request reads the previous prompt from cache and reports it separately.
      request(3, "2026-09-01T08:00:07Z", {
        input_tokens: 2_500,
        cache_read_tokens: 7_301,
        output_tokens: 250,
      }),
      "{ not json",
      step(4, "PLANNER_RESPONSE", { created_at: undefined, input_tokens: 9, output_tokens: 9 }),
      step(5, "CHECKPOINT"),
    ];
    const file = await transcript("conv-a", lines);
    // The same steps repeated elsewhere in the store are not separate requests.
    await transcript("conv-a", lines, "transcript_full.jsonl");
    await transcript("conv-a", lines, path.join("chunks", "transcript", "00000000.jsonl"));

    const statistics = createAntigravityUsageStatistics(environment());
    const sources = await statistics.listSources(signal);
    expect(sources.map(({ id }) => id)).toEqual([file]);
    expect(await statistics.readSource(file, signal)).toEqual([
      {
        id: "2026-09-01T08:00:01Z:1:7000:0:300",
        occurredAtMs: Date.parse("2026-09-01T08:00:01Z"),
        inputTokens: 7_000,
        cachedInputTokens: 0,
        outputTokens: 300,
        sessionId: "conv-a",
      },
      {
        id: "2026-09-01T08:00:07Z:3:2500:7301:250",
        occurredAtMs: Date.parse("2026-09-01T08:00:07Z"),
        inputTokens: 9_801,
        cachedInputTokens: 7_301,
        outputTokens: 250,
        sessionId: "conv-a",
      },
    ]);
  });

  it("gives a request copied into a derived Conversation the same ID", async () => {
    const original = request(1, "2026-09-01T08:00:01Z", {
      input_tokens: 7_000,
      cache_read_tokens: 0,
      output_tokens: 300,
    });
    const parent = await transcript("conv-parent", [original]);
    const derived = await transcript("conv-derived", [
      original,
      request(3, "2026-09-01T09:30:00Z", {
        input_tokens: 1_200,
        cache_read_tokens: 7_301,
        output_tokens: 80,
      }),
    ]);
    const statistics = createAntigravityUsageStatistics(environment());
    const [fromParent, fromDerived] = await Promise.all([
      statistics.readSource(parent, signal),
      statistics.readSource(derived, signal),
    ]);
    expect(fromDerived.map(({ id }) => id)).toEqual([
      fromParent[0]?.id,
      "2026-09-01T09:30:00Z:3:1200:7301:80",
    ]);
    expect(fromDerived.map(({ sessionId }) => sessionId)).toEqual(["conv-derived", "conv-derived"]);
  });

  it("keeps the last record of a step written twice and leaves an unreported cache unknown", async () => {
    const file = await transcript("conv-b", [
      request(1, "2026-09-01T08:00:01Z", {
        input_tokens: 500,
        cache_read_tokens: 0,
        output_tokens: 10,
      }),
      request(1, "2026-09-01T08:00:01Z", {
        input_tokens: 500,
        cache_read_tokens: 0,
        output_tokens: 42,
      }),
      request(3, "2026-09-01T08:01:00Z", { input_tokens: 900, output_tokens: 20 }),
    ]);
    const entries = await createAntigravityUsageStatistics(environment()).readSource(file, signal);
    expect(entries.map(({ outputTokens }) => outputTokens)).toEqual([42, 20]);
    expect(entries[1]).toEqual({
      id: "2026-09-01T08:01:00Z:3:900:-:20",
      occurredAtMs: Date.parse("2026-09-01T08:01:00Z"),
      inputTokens: 900,
      outputTokens: 20,
      sessionId: "conv-b",
    });
  });

  it("lists only Conversations with a transcript and treats a missing store as empty", async () => {
    const statistics = createAntigravityUsageStatistics(environment());
    expect(await statistics.listSources(signal)).toEqual([]);

    await mkdir(brain("conv-without-logs"), { recursive: true });
    await writeFile(brain("not-a-conversation.jsonl"), "{}\n");
    const emptyLogs = brain("conv-empty", ".system_generated", "logs");
    await mkdir(emptyLogs, { recursive: true });
    await writeFile(path.join(emptyLogs, "transcript.jsonl"), "");
    const file = await transcript("conv-c", [
      request(1, "2026-09-01T08:00:01Z", {
        input_tokens: 1,
        cache_read_tokens: 0,
        output_tokens: 1,
      }),
    ]);
    const sources = await statistics.listSources(signal);
    expect(sources.map(({ id }) => id)).toEqual([file]);
    expect(sources[0]?.fingerprint).toMatch(/^\d+:\d+:[\d.]+$/u);
    await expect(statistics.listSources(AbortSignal.abort())).rejects.toThrow();
  });

  it("rejects a transcript appended after listing and reads it once listed again", async () => {
    const file = await transcript("conv-live", [
      request(1, "2026-09-01T08:00:01Z", {
        input_tokens: 100,
        cache_read_tokens: 0,
        output_tokens: 10,
      }),
    ]);
    const statistics = createAntigravityUsageStatistics(environment());
    const [listed] = await statistics.listSources(signal);
    // agy writes the next step while a Turn is still running.
    await appendFile(
      file,
      `${request(3, "2026-09-01T08:00:09Z", {
        input_tokens: 40,
        cache_read_tokens: 101,
        output_tokens: 12,
      })}\n`,
    );
    await expect(statistics.readSource(file, signal)).rejects.toSatisfy(
      HarnessUsageSourceChangedError.is,
    );
    const [relisted] = await statistics.listSources(signal);
    expect(relisted?.fingerprint).not.toBe(listed?.fingerprint);
    expect(
      (await statistics.readSource(file, signal)).map(({ inputTokens }) => inputTokens),
    ).toEqual([100, 141]);
  });

  it("skips a Conversation whose log path is not a directory", async () => {
    await mkdir(brain("conv-odd"), { recursive: true });
    await writeFile(brain("conv-odd", ".system_generated"), "");
    expect(await createAntigravityUsageStatistics(environment()).listSources(signal)).toEqual([]);
  });

  it("skips Conversations whose log directories link elsewhere", async () => {
    const outside = path.join(home, "outside");
    await mkdir(path.join(outside, "logs"), { recursive: true });
    await writeFile(
      path.join(outside, "logs", "transcript.jsonl"),
      `${request(1, "2026-09-01T08:00:01Z", { input_tokens: 1, cache_read_tokens: 0, output_tokens: 1 })}\n`,
    );
    // Junctions need no extra privilege on Windows; elsewhere this is a directory link.
    const type = process.platform === "win32" ? "junction" : "dir";
    await mkdir(brain("conv-linked-system"), { recursive: true });
    await symlink(outside, brain("conv-linked-system", ".system_generated"), type);
    await mkdir(brain("conv-linked-logs", ".system_generated"), { recursive: true });
    await symlink(
      path.join(outside, "logs"),
      brain("conv-linked-logs", ".system_generated", "logs"),
      type,
    );
    const real = await transcript("conv-real", [
      request(1, "2026-09-01T08:00:01Z", {
        input_tokens: 1,
        cache_read_tokens: 0,
        output_tokens: 1,
      }),
    ]);
    const sources = await createAntigravityUsageStatistics(environment()).listSources(signal);
    expect(sources.map(({ id }) => id)).toEqual([real]);
  });

  it("reports a listed transcript removed before reading as a changed source", async () => {
    const file = await transcript("conv-gone", [
      request(1, "2026-09-01T08:00:01Z", {
        input_tokens: 1,
        cache_read_tokens: 0,
        output_tokens: 1,
      }),
    ]);
    const statistics = createAntigravityUsageStatistics(environment());
    expect((await statistics.listSources(signal)).map(({ id }) => id)).toEqual([file]);
    await rm(file);
    await expect(statistics.readSource(file, signal)).rejects.toSatisfy(
      HarnessUsageSourceChangedError.is,
    );
    expect(await statistics.listSources(signal)).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a transcript it is not allowed to inspect instead of hiding it",
    async () => {
      await transcript("conv-locked", [
        request(1, "2026-09-01T08:00:01Z", {
          input_tokens: 1,
          cache_read_tokens: 0,
          output_tokens: 1,
        }),
      ]);
      const locked = brain("conv-locked", ".system_generated");
      await chmod(locked, 0o000);
      try {
        await expect(
          createAntigravityUsageStatistics(environment()).listSources(signal),
        ).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        await chmod(locked, 0o700);
      }
    },
  );

  it("is exposed by the Adapter for the Host's machine-wide statistics", async () => {
    const file = await transcript("conv-d", [
      request(1, "2026-09-01T08:00:01Z", {
        input_tokens: 10,
        cache_read_tokens: 5,
        output_tokens: 2,
      }),
    ]);
    const adapter = new AntigravityAdapter({ environment: environment() });
    try {
      const sources = await adapter.usageStatistics.listSources(signal);
      expect(sources.map(({ id }) => id)).toEqual([file]);
      expect(await adapter.usageStatistics.readSource(file, signal)).toMatchObject([
        { inputTokens: 15, cachedInputTokens: 5, outputTokens: 2, sessionId: "conv-d" },
      ]);
    } finally {
      await adapter.close();
    }
  });
});
