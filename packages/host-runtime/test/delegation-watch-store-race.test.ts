import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  beforeRename: undefined as ((from: string, to: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      await hooks.beforeRename?.(from, to);
      return actual.rename(from, to);
    },
  };
});

const { FileDelegationWatchStore } = await import("../src/delegation-watch-store.js");

const bootSeconds = () => Math.round(Date.now() / 1_000 - os.uptime());

describe("FileDelegationWatchStore adoption race", () => {
  let directory: string;

  beforeEach(async () => {
    directory = path.join(await mkdtemp(path.join(os.tmpdir(), "codexhost-watch-")), "watches");
  });
  afterEach(async () => {
    hooks.beforeRename = undefined;
    await rm(path.dirname(directory), { recursive: true, force: true });
  });

  it("hands back a record another adopter saved between its read and its claim", async () => {
    await mkdir(directory, { recursive: true });
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const record = {
      id: "race",
      threadId: "child",
      notifyThreadId: "parent",
      state: "watching",
      registeredAt: "2026-11-03T00:00:00.000Z",
      timeoutMs: 60_000,
      deadline: 1_000,
    };
    await writeFile(
      path.join(directory, "race.json"),
      `${JSON.stringify({ formatVersion: 1, owner: { pid: dead, boot: bootSeconds() }, watch: record })}\n`,
    );
    const first = new FileDelegationWatchStore(directory);
    let firstAdopted: unknown[] = [];
    // The late adopter has read the exited owner's record. Before its claim
    // rename runs, another adopter takes the record and saves it as its own.
    hooks.beforeRename = async (_from, to) => {
      if (!to.includes(".claim-")) return;
      hooks.beforeRename = undefined;
      firstAdopted = await first.adopt();
    };
    const late = await new FileDelegationWatchStore(directory).adopt();

    expect(firstAdopted).toEqual([record]);
    expect(late).toEqual([]);
    expect(await readdir(directory)).toEqual(["race.json"]);
    const saved = JSON.parse(await readFile(path.join(directory, "race.json"), "utf8"));
    expect(saved).toMatchObject({ owner: { pid: process.pid }, watch: record });
  });
});
