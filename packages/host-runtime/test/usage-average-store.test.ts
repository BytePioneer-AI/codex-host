import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { UsageMeasurementsStore } from "../src/usage-measurements-store.js";

it("merges concurrent request timing snapshots once and filters removed Turns on reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-average-"));
  const a = new UsageMeasurementsStore(directory, () => {});
  const b = new UsageMeasurementsStore(directory, () => {});
  const first = {
    version: 3 as const,
    requestId: "a",
    turnId: "one",
    outputTokens: 100,
    startedAtMs: 1000,
    completedAtMs: 2000,
  };
  const second = {
    version: 3 as const,
    requestId: "b",
    turnId: "two",
    outputTokens: 300,
    startedAtMs: 10_000,
    completedAtMs: 19_000,
  };
  try {
    a.record("scope", "s", "one", 2000, { outputTimings: [first] });
    b.record("scope", "s", "two", 19_000, { outputTimings: [first, second] });
    await Promise.all([a.flush("scope", "s"), b.flush("scope", "s")]);
    await Promise.all([a.close(), b.close()]);
    const reopened = new UsageMeasurementsStore(directory, () => {});
    try {
      expect((await reopened.read("scope", "s", new Set(["one", "two"]))).outputTimings).toEqual([
        first,
        second,
      ]);
      expect((await reopened.read("scope", "s", new Set(["one"]))).outputTimings).toEqual([first]);
      expect(await reopened.read("other-scope", "s", new Set(["one", "two"]))).toEqual({});
      expect(await reopened.read("scope", "s", new Set())).toEqual({});
    } finally {
      await reopened.close();
    }
  } finally {
    await Promise.all([a.close(), b.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});
