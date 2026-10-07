import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodexUsageStatistics, readCodexRollouts } from "../src/usage-statistics.js";
import { createUsageStatisticsAdapter } from "../src/plugin.js";
import { copyRelation } from "../src/rollout-io.js";

const THREAD = "00000000-0000-4000-8000-000000000001";
const CHILD = "00000000-0000-4000-8000-000000000002";
const BASE = Date.parse("2026-01-01T00:00:00Z");
const signal = new AbortController().signal;
let root: string;
function tokens(input: number, output: number, cached = 0) {
  return {
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    reasoning_output_tokens: 0,
  };
}
function row(type: string, payload: unknown, seconds = 0) {
  return { timestamp: new Date(BASE + seconds * 1000).toISOString(), type, payload };
}
function meta(id = THREAD, extra = {}) {
  return row("session_meta", { id, session_id: id, ...extra });
}
function context(turn_id = "turn", model = "priced-model") {
  return row("turn_context", { turn_id, model });
}
function count(total: unknown, last: unknown, seconds = 1) {
  return row(
    "event_msg",
    { type: "token_count", info: { total_token_usage: total, last_token_usage: last } },
    seconds,
  );
}
function record(id: string, amount: unknown, total: unknown, seconds = 1, thread = THREAD) {
  return row(
    "token_usage_record",
    {
      response_id: id,
      thread_id: thread,
      session_id: thread,
      turn_id: "turn",
      usage: amount,
      thread_token_usage: total,
    },
    seconds,
  );
}
const filename = (thread = THREAD) => `rollout-2026-01-01T00-00-00-${thread}.jsonl`;
async function file(name: string, rows: unknown[]) {
  const target = path.join(root, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, rows.map((v) => JSON.stringify(v)).join("\n") + "\n");
  return target;
}
async function read(rows: unknown[]) {
  return readCodexRollouts([await file("test.jsonl", rows)], THREAD, signal);
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codex-usage-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Codex native counters", () => {
  it.each([
    ["codex-native-compaction.jsonl", 4, 543177, 8001, 520320],
    ["codex-native-paginated.jsonl", 3, 383010, 293, 254720],
    ["codex-compaction-counter-domains.jsonl", 4, 507797, 6856, 496640],
  ])("matches the sanitized native fixture %s", async (name, calls, input, output, cached) => {
    const source = path.join(import.meta.dirname, "fixtures", name);
    const first = JSON.parse((await readFile(source, "utf8")).split("\n")[0] ?? "{}");
    const entries = await readCodexRollouts([source], first.payload.id, signal);
    expect(entries).toHaveLength(calls);
    expect(entries.reduce((sum, e) => sum + e.inputTokens, 0)).toBe(input);
    expect(entries.reduce((sum, e) => sum + e.outputTokens, 0)).toBe(output);
    expect(entries.reduce((sum, e) => sum + (e.cachedInputTokens ?? 0), 0)).toBe(cached);
  });

  it("uses cumulative deltas, ignores repeated checkpoints, and counts runtime resets", async () => {
    const a = tokens(100, 10, 50),
      total = tokens(250, 30, 100),
      last = tokens(150, 20, 50);
    const entries = await read([
      meta(),
      context(),
      count(a, a),
      count(a, a, 2),
      count(total, last, 3),
      // A reset can start with a request larger than the preceding runtime total.
      count(tokens(500, 50, 200), tokens(500, 50, 200), 4),
      count(tokens(600, 60, 250), a, 5),
    ]);
    expect(entries.map((e) => [e.inputTokens, e.outputTokens])).toEqual([
      [100, 10],
      [150, 20],
      [500, 50],
      [100, 10],
    ]);
  });

  it.each([false, true])(
    "pairs RECORD and legacy checkpoints in either order (record first: %s)",
    async (before) => {
      const a = tokens(100, 10, 50);
      const r = record("response", a, tokens(1100, 110, 550));
      const c = count(tokens(900, 90, 450), a);
      const entries = await read([meta(), context(), ...(before ? [r, c] : [c, r]), r]);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        id: `${THREAD}:response`,
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 50,
      });
    },
  );

  it("does not pair equal-sized requests across turn boundaries and preserves model changes", async () => {
    const a = tokens(100, 10);
    const entries = await read([
      meta(),
      context("first", "a"),
      count(a, a),
      row("event_msg", { type: "task_started", turn_id: "second" }, 2),
      context("second", "b"),
      row(
        "token_usage_record",
        {
          response_id: "second",
          session_id: THREAD,
          thread_id: THREAD,
          turn_id: "second",
          usage: a,
        },
        3,
      ),
    ]);
    expect(entries.map((e) => e.model)).toEqual(["a", "b"]);
  });

  it("keeps first completion time on a later corrected response and ignores stale snapshots", async () => {
    const a = tokens(100, 10),
      b = tokens(110, 12);
    const entries = await read([
      meta(),
      context(),
      record("x", a, a),
      record("x", b, b, 3),
      record("x", a, a, 2),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      occurredAtMs: BASE + 1000,
      inputTokens: 110,
      outputTokens: 12,
    });
  });

  it("retains a known checkpoint when a repeated response omits its cumulative total", async () => {
    const a = tokens(100, 10);
    const entries = await read([
      meta(),
      context(),
      record("x", a, a),
      record("x", a, null, 2),
      count(a, a, 3),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(`${THREAD}:x`);
  });

  it("does not price unknown models or silently fill missing optional token buckets", async () => {
    const entries = await read([
      meta(),
      record("x", { input_tokens: 100, output_tokens: 10 }, null),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty("model");
    expect(entries[0]).not.toHaveProperty("cacheWriteInputTokens");
    expect(await read([meta(), record("invalid", tokens(10, 1, 100), null)])).toEqual([]);
  });

  it("attributes requests to the thread and the first session metadata's working directory", async () => {
    const entries = await read([
      meta(THREAD, { cwd: "/work/codex" }),
      // A later resume's metadata does not move earlier or later requests elsewhere.
      meta(THREAD, { cwd: "/elsewhere" }),
      context(),
      record("r1", tokens(100, 10, 50), tokens(100, 10, 50)),
    ]);
    expect(entries).toEqual([expect.objectContaining({ sessionId: THREAD, cwd: "/work/codex" })]);
    const bare = await read([meta(), context(), record("r2", tokens(100, 10, 50), null)]);
    expect(bare[0]).toMatchObject({ sessionId: THREAD });
    expect(bare[0]).not.toHaveProperty("cwd");
  });

  it("excludes inherited fork history while keeping the child's own requests", async () => {
    const a = tokens(100, 10);
    const source = await file("child.jsonl", [
      row("session_meta", { id: CHILD, session_id: CHILD, forked_from_id: THREAD }, 10),
      context(),
      count(a, a, 1),
      record("parent", a, a, 1),
      record("child", a, a, 11, CHILD),
    ]);
    const entries = await readCodexRollouts([source], CHILD, signal);
    expect(entries.map((e) => e.id)).toEqual([`${CHILD}:child`]);
  });

  it("counts a compaction once even when the next checkpoint does not include it", async () => {
    const a = tokens(100, 10, 50),
      compact = tokens(50, 5, 0);
    const c = record("compact", compact, tokens(150, 15, 50), 2);
    const entries = await read([
      meta(),
      context(),
      count(a, a),
      c,
      row(
        "compacted",
        { compaction_response_id: "compact", latest_token_usage_record: c.payload },
        2,
      ),
      count(a, tokens(0, 0), 3),
      record("next", a, tokens(250, 25, 100), 4),
      count(tokens(200, 20, 100), a, 4),
    ]);
    expect(entries).toHaveLength(3);
    expect(entries.reduce((sum, e) => sum + e.inputTokens, 0)).toBe(250);
  });
});

describe("Codex read-only storage", () => {
  it("discovers configured home, combines resumed files, proves archive prefixes, and detects changes", async () => {
    const initial = [meta(), context(), count(tokens(100, 10), tokens(100, 10))];
    const a = await file(`sessions/2026/01/01/${filename()}`, initial);
    await file(`archived_sessions/${filename()}`, [
      ...initial,
      count(tokens(250, 30), tokens(150, 20), 2),
    ]);
    await file(`sessions/2026/01/02/rollout-2026-01-02T00-00-00-${THREAD}_${CHILD}.jsonl`, [
      meta(),
      context(),
      count(tokens(300, 40), tokens(50, 10), 3),
    ]);
    const reader = createCodexUsageStatistics({ CODEX_HOME: root });
    const sources = await reader.listSources(signal);
    expect(sources).toHaveLength(1);
    const source = sources[0];
    if (!source) throw new Error("missing fixture source");
    const before = await stat(a);
    expect((await reader.readSource(source.id, signal)).map((e) => e.inputTokens)).toEqual([
      100, 150, 50,
    ]);
    expect((await stat(a)).mtimeMs).toBe(before.mtimeMs);
    await file(`sessions/2026/01/01/${filename()}`, [
      ...initial,
      count(tokens(400, 40), tokens(300, 30), 4),
    ]);
    await expect(reader.readSource(source.id, signal)).rejects.toThrow("changed while reading");
    expect((await reader.listSources(signal))[0]?.fingerprint).not.toBe(source.fingerprint);
  });

  it("does not discard divergent archive files merely because their names match", async () => {
    const a = tokens(100, 10);
    await file(`sessions/${filename()}`, [meta(), context(), record("a", a, a)]);
    await file(`archived_sessions/${filename()}`, [meta(), context(), record("b", a, a)]);
    const reader = createCodexUsageStatistics({ CODEX_HOME: root });
    const sources = await reader.listSources(signal),
      source = sources[0];
    if (!source) throw new Error("missing fixture source");
    expect(await reader.readSource(source.id, signal)).toHaveLength(2);
  });

  it("decodes every concatenated zstd frame, including a line crossing frames", async () => {
    const original = await file("plain.jsonl", [
      meta(),
      context(),
      count(tokens(100, 10), tokens(100, 10)),
    ]);
    const bytes = await readFile(original),
      compressed = path.join(root, `${filename()}.zst`);
    await writeFile(
      compressed,
      Buffer.concat([
        zstdCompressSync(bytes.subarray(0, 37)),
        zstdCompressSync(bytes.subarray(37)),
      ]),
    );
    expect(await readCodexRollouts([compressed], THREAD, signal)).toHaveLength(1);
    expect(await copyRelation(original, compressed, signal)).toBe("equal");
    await writeFile(compressed, (await readFile(compressed)).subarray(0, -1));
    await expect(readCodexRollouts([compressed], THREAD, signal)).rejects.toThrow();
    await expect(copyRelation(original, compressed, signal)).rejects.toThrow();
  });

  it("rejects corrupt compressed input and cancels reads", async () => {
    const bad = path.join(root, "bad.zst");
    await writeFile(bad, Buffer.alloc(16));
    await expect(readCodexRollouts([bad], THREAD, signal)).rejects.toThrow("Invalid Codex zstd");
    await expect(readCodexRollouts([bad], THREAD, AbortSignal.abort())).rejects.toThrow();
  });

  it("skips symlinks, handles absent directories, and exposes no chat operations", async () => {
    const adapter = createUsageStatisticsAdapter({
      environment: { CODEX_HOME: root },
      platform: process.platform,
      managedRemoteHost: false,
    });
    expect(adapter).not.toHaveProperty("open");
    expect(adapter).not.toHaveProperty("inspect");
    expect(await adapter.usageStatistics.listSources(signal)).toEqual([]);
    const original = await file(`outside/${filename()}`, [meta()]);
    await mkdir(path.join(root, "sessions"));
    if (process.platform !== "win32") {
      await symlink(original, path.join(root, "sessions", filename()));
      expect(await adapter.usageStatistics.listSources(signal)).toEqual([]);
    }
    await adapter.close();
    await expect(adapter.usageStatistics.listSources(signal)).rejects.toThrow();
  });
});
