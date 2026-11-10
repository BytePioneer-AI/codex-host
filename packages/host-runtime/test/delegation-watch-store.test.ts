import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileDelegationWatchStore, type PersistedWatch } from "../src/delegation-watch-store.js";

const bootSeconds = () => Math.round(Date.now() / 1_000 - os.uptime());

function watch(id: string, patch: Partial<PersistedWatch> = {}): PersistedWatch {
  return {
    id,
    threadId: "child",
    notifyThreadId: "parent",
    state: "watching",
    registeredAt: "2026-11-03T00:00:00.000Z",
    timeoutMs: 60_000,
    deadline: 1_000,
    ...patch,
  };
}

/** The pid of a process that has already exited. */
function exitedPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  if (child.pid === undefined) throw new Error("could not start a process");
  return child.pid;
}

async function writeForeign(
  directory: string,
  name: string,
  owner: { pid: number; boot: number },
  record: PersistedWatch,
): Promise<void> {
  await writeFile(
    path.join(directory, name),
    `${JSON.stringify({ formatVersion: 1, owner, watch: record })}\n`,
  );
}

describe("FileDelegationWatchStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = path.join(await mkdtemp(path.join(os.tmpdir(), "codexhost-watch-")), "watches");
  });
  afterEach(async () => {
    await rm(path.dirname(directory), { recursive: true, force: true });
  });

  it("writes one private record per watch and removes it", async () => {
    const store = new FileDelegationWatchStore(directory);
    await store.save(watch("a"));
    await store.save(watch("a", { state: "pendingDelivery", outcome: "completed" }));
    expect(await readdir(directory)).toEqual(["a.json"]);
    const file = JSON.parse(await readFile(path.join(directory, "a.json"), "utf8"));
    expect(file).toMatchObject({
      formatVersion: 1,
      owner: { pid: process.pid },
      watch: { id: "a", state: "pendingDelivery", outcome: "completed" },
    });
    if (process.platform !== "win32") {
      expect((await stat(path.join(directory, "a.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    await store.remove("a");
    expect(await readdir(directory)).toEqual([]);
  });

  it("returns nothing when no Runtime has stored watches", async () => {
    await expect(new FileDelegationWatchStore(directory).adopt()).resolves.toEqual([]);
  });

  it("adopts the silence threshold but not a stalled outcome, which is never stored", async () => {
    await mkdir(directory, { recursive: true });
    const record = watch("silent", { stallAfterMs: 3_000 });
    const owner = { pid: exitedPid(), boot: bootSeconds() };
    await writeForeign(directory, "silent.json", owner, record);
    await writeForeign(
      directory,
      "stalled.json",
      owner,
      watch("stalled", { stallAfterMs: 3_000, state: "pendingDelivery", outcome: "stalled" }),
    );
    const diagnose = vi.fn();
    await expect(new FileDelegationWatchStore(directory, diagnose).adopt()).resolves.toEqual([
      record,
    ]);
    expect(diagnose).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5])("rejects a stored invalid silence threshold %s", async (stallAfterMs) => {
    await mkdir(directory, { recursive: true });
    await writeForeign(
      directory,
      "bad-stall.json",
      { pid: exitedPid(), boot: bootSeconds() },
      watch("bad-stall", { stallAfterMs }),
    );
    const diagnose = vi.fn();
    await expect(new FileDelegationWatchStore(directory, diagnose).adopt()).resolves.toEqual([]);
    expect(diagnose).toHaveBeenCalledOnce();
  });

  it("leaves records of a running Runtime alone", async () => {
    await new FileDelegationWatchStore(directory).save(watch("mine"));
    await expect(new FileDelegationWatchStore(directory).adopt()).resolves.toEqual([]);
    expect(await readdir(directory)).toEqual(["mine.json"]);
  });

  it("adopts records of an exited Runtime and takes ownership", async () => {
    await mkdir(directory, { recursive: true });
    await writeForeign(
      directory,
      "old.json",
      { pid: exitedPid(), boot: bootSeconds() },
      watch("old"),
    );

    const adopted = await new FileDelegationWatchStore(directory).adopt();
    expect(adopted).toEqual([watch("old")]);
    expect(await readdir(directory)).toEqual(["old.json"]);
    const file = JSON.parse(await readFile(path.join(directory, "old.json"), "utf8"));
    expect(file.owner.pid).toBe(process.pid);
  });

  it("treats an owner from an earlier boot as exited even if its pid is in use", async () => {
    await mkdir(directory, { recursive: true });
    await writeForeign(
      directory,
      "rebooted.json",
      { pid: process.pid, boot: 1 },
      watch("rebooted"),
    );
    await expect(new FileDelegationWatchStore(directory).adopt()).resolves.toEqual([
      watch("rebooted"),
    ]);
  });

  it("adopts a claim left by an adopter that exited mid-way", async () => {
    await mkdir(directory, { recursive: true });
    await writeForeign(
      directory,
      `half.json.claim-${exitedPid()}`,
      { pid: exitedPid(), boot: bootSeconds() },
      watch("half"),
    );
    await expect(new FileDelegationWatchStore(directory).adopt()).resolves.toEqual([watch("half")]);
    expect(await readdir(directory)).toEqual(["half.json"]);
  });

  it("lets only one of two concurrent adopters take a record", async () => {
    await mkdir(directory, { recursive: true });
    await writeForeign(
      directory,
      "race.json",
      { pid: exitedPid(), boot: bootSeconds() },
      watch("race"),
    );
    const [left, right] = await Promise.all([
      new FileDelegationWatchStore(directory).adopt(),
      new FileDelegationWatchStore(directory).adopt(),
    ]);
    expect([...left, ...right]).toEqual([watch("race")]);
  });

  it("sets aside an unreadable record and reports it", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "bad.json"), "{ not json");
    await writeForeign(
      directory,
      "traversal.json",
      { pid: exitedPid(), boot: bootSeconds() },
      watch("../escape"),
    );
    const diagnose = vi.fn();
    await expect(new FileDelegationWatchStore(directory, diagnose).adopt()).resolves.toEqual([]);
    expect(diagnose).toHaveBeenCalledTimes(2);
    const names = await readdir(directory);
    expect(names.filter((name) => name.endsWith(".invalid"))).toHaveLength(2);
    expect(names.some((name) => name.endsWith(".json"))).toBe(false);
  });
});
