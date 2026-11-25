import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createDshUsageStatistics, zstdFrames } from "../src/modern/usage-statistics.js";

let home: string;
const signal = new AbortController().signal;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "dsh-usage-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function message(id: string, time: number, output: number): string {
  return JSON.stringify({
    type: "assistant/message",
    seq: time,
    time,
    surfaceOp: "append",
    data: {
      message: {
        id,
        role: "assistant",
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-pro" },
      },
      usage: { inputTokens: 10, outputTokens: output, cacheReadTokens: 90, cacheWriteTokens: 0 },
      stream: [],
    },
  });
}

it("reads every complete zstd frame of the newest session file", async () => {
  const session = path.join(home, "sessions", "--work--", "s1");
  await mkdir(session, { recursive: true });
  const header = JSON.stringify({ type: "session", version: 4, id: "s1", cwd: "/work/dsh" });
  const frames = [
    zstdCompressSync(`${header}\n${message("m1", 1_000, 3)}\n`),
    zstdCompressSync(`${message("m2", 2_000, 4)}\n`),
  ];
  const partial = zstdCompressSync(`${message("m3", 3_000, 5)}\n`).subarray(0, 12);
  await writeFile(path.join(session, "session.v4.jsonl.zstd"), Buffer.concat([...frames, partial]));
  // Left behind by an older format; not read.
  await writeFile(path.join(session, "session.jsonl"), `${header}\n${message("old", 500, 9)}\n`);
  await writeFile(path.join(session, "session.migration.x.jsonl.zstd.tmp"), "x");

  expect(zstdFrames(Buffer.concat([...frames, partial]))).toHaveLength(2);
  const capability = createDshUsageStatistics({ DSH_HOME: home });
  const sources = await capability.listSources(signal);
  expect(sources.map((source) => path.basename(source.id))).toEqual(["session.v4.jsonl.zstd"]);
  expect(await capability.readSource(sources[0]?.id ?? "", signal)).toEqual([
    {
      id: "m1",
      occurredAtMs: 1_000,
      model: "deepseek-v4-pro",
      inputTokens: 100,
      cachedInputTokens: 90,
      cacheWriteInputTokens: 0,
      outputTokens: 3,
      sessionId: "s1",
      cwd: "/work/dsh",
    },
    // The header is in the first frame; later frames' requests belong to the same session.
    expect.objectContaining({ id: "m2", occurredAtMs: 2_000, outputTokens: 4, sessionId: "s1" }),
  ]);
});
