import { mkdtemp, readdir, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { UsageMeasurementsStore } from "../src/usage-measurements-store.js";

it("buffers frequent observations, saves one bounded snapshot at a boundary, and flushes shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-snapshot-"));
  const store = new UsageMeasurementsStore(directory, () => {});
  const folder = join(directory, "usage-measurements-v1");
  try {
    store.record("scope", "session", "t1", 1, { timeToFirstOutputMs: 40 });
    for (let n = 1; n <= 100; n++)
      store.record("scope", "session", "t1", n, { outputTokensPerSecond: n });
    await expect(readdir(folder)).rejects.toMatchObject({ code: "ENOENT" });
    await store.flush("scope", "session");
    const files = await readdir(folder);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/u);
    if (!files[0]) throw new Error("Missing snapshot");
    const file = join(folder, files[0]);
    const first = await readFile(file, "utf8");
    expect(first.length).toBeLessThan(1024);
    expect(JSON.parse(first).values.outputTokensPerSecond.value).toBe(100);
    const stamp = (await stat(file, { bigint: true })).mtimeNs;
    store.record("scope", "session", "t1", 101, { outputTokensPerSecond: 100 });
    await store.flush("scope", "session");
    expect((await stat(file, { bigint: true })).mtimeNs).toBe(stamp);
    store.record("scope", "session", "t2", 200, { outputTokensPerSecond: 20 });
    const saving = store.flush("scope", "session");
    store.record("scope", "session", "t3", 300, { outputTokensPerSecond: 30 });
    await saving;
    expect(JSON.parse(await readFile(file, "utf8")).values.outputTokensPerSecond.turnId).toBe("t2");
    await store.close();
    const reopened = new UsageMeasurementsStore(directory, () => {});
    expect(await reopened.read("scope", "session", new Set(["t1", "t3"]))).toMatchObject({
      outputTokensPerSecond: { value: 30 },
      timeToFirstOutputMs: { value: 40 },
    });
    expect(await reopened.read("other-home", "session", new Set(["t3"]))).toEqual({});
    expect(await reopened.read("scope", "session", new Set(["removed"]))).toEqual({});
    expect(await readdir(folder)).toHaveLength(1);
    await reopened.close();
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("merges concurrent observers and migrates a legacy log only when saving", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-snapshot-legacy-"));
  const folder = join(directory, "usage-measurements-v1");
  const key = createHash("sha256")
    .update(JSON.stringify(["scope", "session"]))
    .digest("hex");
  await mkdir(folder);
  await writeFile(
    join(folder, key + ".jsonl"),
    [
      JSON.stringify({
        version: 1,
        turnId: "t",
        at: 10,
        values: { outputTokensPerSecond: 10, timeToFirstOutputMs: 60 },
      }),
      "invalid record",
      JSON.stringify({ version: 1, turnId: "t", at: 20, values: { outputTokensPerSecond: 20 } }),
    ].join("\n") + "\n",
  );
  const a = new UsageMeasurementsStore(directory, () => {}),
    b = new UsageMeasurementsStore(directory, () => {});
  try {
    const legacy = await a.read("scope", "session", new Set(["t"]));
    expect(legacy.outputTokensPerSecond).toBeUndefined();
    expect(legacy.timeToFirstOutputMs).toMatchObject({ value: 60 });
    expect(await readdir(folder)).toEqual([key + ".jsonl"]);
    b.record("scope", "session", "t", 30, { timeToFirstOutputMs: 50 });
    await Promise.all([a.flush("scope", "session"), b.flush("scope", "session")]);
    const disk = JSON.parse(await readFile(join(folder, key + ".json"), "utf8"));
    expect(disk.values.outputTokensPerSecond).toBeUndefined();
    expect(disk.values).toMatchObject({ timeToFirstOutputMs: { value: 50 } });
    expect(await readdir(folder)).toEqual([key + ".json"]);
  } finally {
    await a.close();
    await b.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("drops incompatible stored speed and intervals without discarding TTFT", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-snapshot-version-"));
  const folder = join(directory, "usage-measurements-v1");
  const key = createHash("sha256")
    .update(JSON.stringify(["scope", "session"]))
    .digest("hex");
  const file = join(folder, key + ".json");
  const latency = { value: 900, turnId: "t", at: 2000 };
  const diagnose = vi.fn();
  const store = new UsageMeasurementsStore(directory, diagnose);
  try {
    await mkdir(folder);
    const old = JSON.stringify({
      version: 1,
      values: {
        outputTokensPerSecond: { version: 3, value: 120, turnId: "t", at: 2000 },
        outputTimings: [
          {
            version: 3,
            requestId: "old",
            turnId: "t",
            outputTokens: 120,
            startedAtMs: 1000,
            completedAtMs: 2000,
          },
        ],
        timeToFirstOutputMs: latency,
      },
    });
    await writeFile(file, old);
    expect(await store.read("scope", "session", new Set(["t"]))).toEqual({
      timeToFirstOutputMs: latency,
    });
    expect(await readFile(file, "utf8")).toBe(old);
    expect(diagnose).not.toHaveBeenCalled();
    store.record("scope", "session", "t", 3000, { outputTokensPerSecond: 40 });
    await store.flush("scope", "session");
    expect(JSON.parse(await readFile(file, "utf8")).values).toEqual({
      outputTokensPerSecond: { version: 4, value: 40, turnId: "t", at: 3000 },
      timeToFirstOutputMs: latency,
    });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("reports optional write failures without rejecting native observation or shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-snapshot-failure-"));
  const diagnose = vi.fn();
  const store = new UsageMeasurementsStore(directory, diagnose);
  try {
    await writeFile(join(directory, "usage-measurements-v1"), "occupied");
    expect(() =>
      store.record("scope", "session", "turn", 100, { outputTokensPerSecond: 20 }),
    ).not.toThrow();
    await expect(store.close()).resolves.toBeUndefined();
    expect(diagnose).toHaveBeenCalledOnce();
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("ignores corrupt snapshots and repairs them only after a new reliable observation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-snapshot-corrupt-"));
  const writer = new UsageMeasurementsStore(directory, () => {});
  const diagnose = vi.fn();
  const reader = new UsageMeasurementsStore(directory, diagnose);
  try {
    writer.record("scope", "s", "t", 1, { outputTokensPerSecond: 10 });
    await writer.close();
    const folder = join(directory, "usage-measurements-v1");
    const [name] = await readdir(folder);
    if (!name) throw new Error("Missing file");
    await writeFile(join(folder, name), "broken");
    expect(await reader.read("scope", "s", new Set(["t"]))).toEqual({});
    expect(await readFile(join(folder, name), "utf8")).toBe("broken");
    reader.record("scope", "s", "t", 2, { outputTokensPerSecond: 20 });
    await reader.flush("scope", "s");
    expect(
      JSON.parse(await readFile(join(folder, name), "utf8")).values.outputTokensPerSecond.value,
    ).toBe(20);
    expect(diagnose).toHaveBeenCalled();
  } finally {
    await writer.close();
    await reader.close();
    await rm(directory, { recursive: true, force: true });
  }
});
