import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostUsageRequest } from "@codexhost/harness-adapter";
import { readAntigravityRequestMetadata } from "../src/native-request-timing.js";
import {
  bytes,
  integer,
  writeNativeTimingDatabase,
} from "../../../../tests/fixtures/antigravity/native-timing-fixture.js";

let home: string;
const request: HostUsageRequest = {
  requestId: "step:1",
  inputTokens: 150,
  outputTokens: 20,
  cachedInputTokens: 50,
  cacheWriteInputTokens: 0,
};
const requests = new Map([[1, request]]);
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "agy-native-timing-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
async function readAntigravityRequestTimings(
  session: string,
  home: string,
  all: ReadonlyMap<number, HostUsageRequest | null>,
  needed = new Set(all.keys()),
) {
  const metadata = await readAntigravityRequestMetadata(session, home, all, needed);
  return metadata === null
    ? null
    : new Map(
        [...metadata].flatMap(([step, facts]) =>
          facts.timing
            ? [
                [
                  step,
                  {
                    startedAtMs: facts.timing.startedAtMs,
                    completedAtMs: facts.timing.completedAtMs,
                  },
                ] as const,
              ]
            : [],
        ),
      );
}
async function read() {
  return await readAntigravityRequestTimings("session", home, requests);
}

describe("Antigravity native request timings", () => {
  it("preserves integer millisecond boundaries in epoch-scale timing fixtures", async () => {
    const created = 1794803308930;
    await writeNativeTimingDatabase(home, [
      { step: 1, created, started: created + 1, completed: created + 3 },
    ]);
    expect((await read())?.get(1)).toEqual({
      startedAtMs: created + 1,
      completedAtMs: created + 3,
    });
  });
  it.each([0, 48])(
    "verifies text-output timing independently of hidden thought tokens: %i",
    async (thought) => {
      await writeNativeTimingDatabase(home, [
        {
          step: 1,
          input: 8856,
          cached: 0,
          output: 544,
          thought,
          created: 1794763967637.624,
          started: 1794763980519.679,
          completed: 1794763991282.717,
        },
      ]);
      const all = new Map([
        [
          1,
          {
            ...request,
            inputTokens: 8856,
            cachedInputTokens: 0,
            outputTokens: 544,
            reasoningOutputTokens: thought,
          },
        ],
      ]);
      const facts = (await readAntigravityRequestMetadata("session", home, all))?.get(1);
      expect(facts?.reasoningOutputTokens).toBe(thought);
      expect(facts?.timing).toEqual({
        requestStartedAtMs: 1794763967637,
        timeToFirstOutputMs: 12882,
        startedAtMs: 1794763980519,
        completedAtMs: 1794763991282,
      });
    },
  );

  it.each([{ thought: 1 }, { thought: 21 }, { generatorThought: 1 }])(
    "rejects inconsistent native/request reasoning counters: %j",
    async (fields) => {
      await writeNativeTimingDatabase(home, [{ step: 1, ...fields }]);
      const all = new Map([[1, { ...request, reasoningOutputTokens: 0 }]]);
      expect(await readAntigravityRequestMetadata("session", home, all)).toEqual(new Map());
    },
  );

  it("preserves step-level thinking facts before generator timing is available", async () => {
    const file = await writeNativeTimingDatabase(home, [{ step: 1, thought: 10 }]);
    const db = new DatabaseSync(file);
    try {
      db.exec("DELETE FROM gen_metadata");
    } finally {
      db.close();
    }
    expect(await readAntigravityRequestMetadata("session", home, requests)).toEqual(
      new Map([[1, { reasoningOutputTokens: 10 }]]),
    );
  });

  it("retains verified usage when timing durations are inconsistent", async () => {
    await writeNativeTimingDatabase(home, [{ step: 1, streamDuration: 1990, thought: 0 }]);
    expect(await readAntigravityRequestMetadata("session", home, requests)).toEqual(
      new Map([[1, { reasoningOutputTokens: 0 }]]),
    );
  });

  it("uses generation boundaries and the proto3 default thought count from verified usage", async () => {
    await writeNativeTimingDatabase(home, [{ step: 1 }]);
    expect(await read()).toEqual(new Map([[1, { startedAtMs: 3000, completedAtMs: 5000 }]]));
    expect((await readAntigravityRequestMetadata("session", home, requests))?.get(1)).toEqual({
      reasoningOutputTokens: 0,
      timing: {
        requestStartedAtMs: 1000,
        timeToFirstOutputMs: 2000,
        startedAtMs: 3000,
        completedAtMs: 5000,
      },
    });
  });

  it("correlates multiple requests by explicit native step indices", async () => {
    await writeNativeTimingDatabase(home, [
      { step: 1 },
      { step: 3, created: 10000, started: 12000, completed: 13000, output: 30 },
    ]);
    const all = new Map([
      [1, request],
      [3, { ...request, requestId: "step:3", outputTokens: 30 }],
    ]);
    expect(await readAntigravityRequestTimings("session", home, all)).toEqual(
      new Map([
        [1, { startedAtMs: 3000, completedAtMs: 5000 }],
        [3, { startedAtMs: 12000, completedAtMs: 13000 }],
      ]),
    );
  });

  it("does not create missing native storage or accept path traversal", async () => {
    expect(await read()).toBeNull();
    expect(existsSync(path.join(home, ".gemini"))).toBe(false);
    expect(await readAntigravityRequestTimings("../session", home, requests)).toBeNull();
  });

  it.each([
    { output: 21 },
    { cached: 49 },
    { input: 99 },
    { streamDuration: 1990 },
    { ttft: 1990 },
    { streamDuration: 0 },
    { started: 5000, completed: 5000 },
    { created: 4000, ttft: 0 },
    { retries: 1 },
    { attempts: 2 },
    { indices: [3, 4] },
    { sourceSession: "another-conversation" },
  ])("rejects mismatched usage, intervals, retries or ownership: %j", async (fields) => {
    await writeNativeTimingDatabase(home, [{ step: 1, ...fields }]);
    expect(await read()).toEqual(new Map());
  });

  it("rejects a generator that links multiple planner requests", async () => {
    await writeNativeTimingDatabase(home, [
      { step: 1, indices: [1, 3] },
      { step: 3, indices: [] },
    ]);
    const all = new Map([
      [1, request],
      [3, { ...request, requestId: "step:3" }],
    ]);
    expect(await readAntigravityRequestTimings("session", home, all)).toEqual(new Map());
  });

  it("uses only the generator explicitly named by the step, not a similar unreferenced record", async () => {
    await writeNativeTimingDatabase(home, [{ step: 1, retries: 1 }, { step: 1 }]);
    expect(await read()).toEqual(new Map([[1, { startedAtMs: 3000, completedAtMs: 5000 }]]));
  });

  it("does not scan unneeded generator records", async () => {
    await writeNativeTimingDatabase(home, [{ step: 1 }, { step: 3 }]);
    const all = new Map([
      [1, request],
      [3, { ...request, requestId: "step:3" }],
    ]);
    expect(await readAntigravityRequestTimings("session", home, all, new Set([3]))).toEqual(
      new Map([[3, { startedAtMs: 3000, completedAtMs: 5000 }]]),
    );
  });

  it("rejects a missing generator reference instead of guessing from row order", async () => {
    const file = await writeNativeTimingDatabase(home, [{ step: 1 }]);
    const db = new DatabaseSync(file);
    try {
      db.exec("UPDATE gen_metadata SET idx = 7");
    } finally {
      db.close();
    }
    expect(await read()).toEqual(new Map());
  });

  it.each([
    Buffer.from([0x80]),
    Buffer.from([0x0a, 0xff]),
    Buffer.from([0x0b]),
    Buffer.from([0x00]),
  ])("ignores damaged metadata: %j", async (blob) => {
    const file = await writeNativeTimingDatabase(home, [{ step: 1 }]);
    const db = new DatabaseSync(file);
    try {
      db.prepare("UPDATE steps SET metadata = ?").run(blob);
    } finally {
      db.close();
    }
    expect(await read()).toEqual(new Map());
  });

  it("does not treat duplicate usage fields as a known zero", async () => {
    const file = await writeNativeTimingDatabase(home, [{ step: 1 }]);
    const db = new DatabaseSync(file);
    try {
      db.prepare("UPDATE steps SET metadata = CAST(metadata || ? AS BLOB)").run(
        bytes(9, integer(3, 20)),
      );
    } finally {
      db.close();
    }
    expect(await read()).toEqual(new Map());
  });

  it("extracts native max_context_tokens even when timing is omitted and ignores zero or mismatched records", async () => {
    await writeNativeTimingDatabase(home, [
      { step: 1, maxContextTokens: 512_000 },
      { step: 3, maxContextTokens: 256_000, retries: 1 },
      { step: 5, maxContextTokens: 840_000, streamDuration: 1990 },
      { step: 7, maxContextTokens: 0 },
      { step: 9, maxContextTokens: 512_000, generatorThought: 1 },
    ]);
    const all = new Map<number, HostUsageRequest>([
      [1, request],
      [3, { ...request, requestId: "step:3" }],
      [5, { ...request, requestId: "step:5" }],
      [7, { ...request, requestId: "step:7" }],
      [9, { ...request, requestId: "step:9", reasoningOutputTokens: 0 }],
    ]);
    const metadata = await readAntigravityRequestMetadata("session", home, all);
    expect(metadata?.get(1)).toMatchObject({
      reasoningOutputTokens: 0,
      contextWindowTokens: 512_000,
      timing: { startedAtMs: 3000, completedAtMs: 5000 },
    });
    expect(metadata?.get(3)).toEqual({
      reasoningOutputTokens: 0,
      contextWindowTokens: 256_000,
    });
    expect(metadata?.get(5)).toEqual({
      reasoningOutputTokens: 0,
      contextWindowTokens: 840_000,
    });
    expect(metadata?.get(7)).not.toHaveProperty("contextWindowTokens");
    expect(metadata?.has(9)).toBe(false);
  });
});
