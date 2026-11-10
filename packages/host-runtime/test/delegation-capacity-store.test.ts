import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FileDelegationQueueStore,
  defaultDelegationQueueDirectory,
  type PersistedQueuedDelegation,
} from "../src/delegation-capacity-store.js";

const bootSeconds = () => Math.round(Date.now() / 1_000 - os.uptime());

function entry(threadId: string, patch: Partial<PersistedQueuedDelegation> = {}) {
  return {
    delegationId: `delegation-${threadId}`,
    threadId,
    turnId: `turn-${threadId}`,
    harnessId: "pi",
    task: "Review the change",
    cwd: "/work",
    parentThreadId: "parent",
    title: "Review",
    taskDigest: "digest",
    queuedAt: 1_000,
    ...patch,
  } satisfies PersistedQueuedDelegation;
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
  owner: { pid: number; boot: number; instance: string },
  queue: unknown[],
): Promise<void> {
  await writeFile(
    path.join(directory, name),
    `${JSON.stringify({ formatVersion: 1, owner, queue })}\n`,
  );
}

describe("FileDelegationQueueStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = path.join(await mkdtemp(path.join(os.tmpdir(), "codexhost-queue-")), "queue");
  });
  afterEach(async () => {
    await rm(path.dirname(directory), { recursive: true, force: true });
  });

  it("lives in the codexhost data directory", () => {
    expect(defaultDelegationQueueDirectory({ CODEXHOST_DATA_DIR: "/data" })).toBe(
      path.join(path.resolve("/data"), "delegation-queue"),
    );
  });

  it("keeps this Runtime's whole queue in one private file and removes it when empty", async () => {
    const store = new FileDelegationQueueStore(directory);
    await store.save([entry("a"), entry("b", { starting: true, requestId: "retry" })]);
    const [name, ...others] = await readdir(directory);
    expect(others).toEqual([]);
    expect(name).toMatch(new RegExp(`^${process.pid}-[0-9a-f]+\\.json$`));
    const file = JSON.parse(await readFile(path.join(directory, name ?? ""), "utf8"));
    expect(file).toMatchObject({
      formatVersion: 1,
      owner: { pid: process.pid },
      queue: [entry("a"), entry("b", { starting: true, requestId: "retry" })],
    });
    if (process.platform !== "win32") {
      expect((await stat(path.join(directory, name ?? ""))).mode & 0o777).toBe(0o600);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    await store.save([]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("returns nothing when no Runtime has stored a queue", async () => {
    await expect(new FileDelegationQueueStore(directory).adopt()).resolves.toEqual([]);
  });

  it("leaves the queue of a running Runtime alone", async () => {
    await mkdir(directory, { recursive: true });
    await writeForeign(
      directory,
      "live.json",
      { pid: process.ppid, boot: bootSeconds(), instance: "other" },
      [entry("live")],
    );
    const own = new FileDelegationQueueStore(directory);
    await own.save([entry("mine")]);
    await expect(own.adopt()).resolves.toEqual([]);
    expect((await readdir(directory)).sort()).toHaveLength(2);
  });

  it("adopts the queues of exited Runtimes in arrival order and takes ownership", async () => {
    await mkdir(directory, { recursive: true });
    const exited = { pid: exitedPid(), boot: bootSeconds(), instance: "exited" };
    await writeForeign(directory, "one.json", exited, [
      entry("late", { queuedAt: 3_000 }),
      entry("early", { queuedAt: 1_000 }),
    ]);
    await writeForeign(directory, "two.json", { ...exited, instance: "second" }, [
      entry("middle", { queuedAt: 2_000, starting: true }),
      entry("early", { queuedAt: 1_000 }),
    ]);

    const store = new FileDelegationQueueStore(directory);
    const adopted = await store.adopt();
    expect(adopted.map((queued) => queued.threadId)).toEqual(["early", "middle", "late"]);
    expect(adopted[1]).toMatchObject({ starting: true });
    const names = await readdir(directory);
    expect(names).toHaveLength(1);
    const file = JSON.parse(await readFile(path.join(directory, names[0] ?? ""), "utf8"));
    expect(file.owner.pid).toBe(process.pid);
    expect(file.queue.map((queued: PersistedQueuedDelegation) => queued.threadId)).toEqual([
      "early",
      "middle",
      "late",
    ]);
  });

  it("treats an earlier process with this pid or an earlier boot as exited", async () => {
    await mkdir(directory, { recursive: true });
    await writeForeign(
      directory,
      "same-pid.json",
      { pid: process.pid, boot: bootSeconds(), instance: "earlier" },
      [entry("same-pid")],
    );
    await writeForeign(
      directory,
      "rebooted.json",
      { pid: process.ppid, boot: 1, instance: "rebooted" },
      [entry("rebooted", { queuedAt: 2_000 })],
    );
    const adopted = await new FileDelegationQueueStore(directory).adopt();
    expect(adopted.map((queued) => queued.threadId)).toEqual(["same-pid", "rebooted"]);
  });

  it("adopts a claim left by an adopter that exited mid-way", async () => {
    await mkdir(directory, { recursive: true });
    await writeForeign(
      directory,
      `half.json.claim-${exitedPid()}.abcd`,
      { pid: exitedPid(), boot: bootSeconds(), instance: "half" },
      [entry("half")],
    );
    const store = new FileDelegationQueueStore(directory);
    await expect(store.adopt()).resolves.toEqual([entry("half")]);
    expect(await readdir(directory)).toEqual([
      expect.stringMatching(new RegExp(`^${process.pid}-[0-9a-f]+\\.json$`)),
    ]);
  });

  it("lets only one of two concurrent adopters take a queue", async () => {
    await mkdir(directory, { recursive: true });
    await writeForeign(
      directory,
      "race.json",
      { pid: exitedPid(), boot: bootSeconds(), instance: "race" },
      [entry("race")],
    );
    const [left, right] = await Promise.all([
      new FileDelegationQueueStore(directory).adopt(),
      new FileDelegationQueueStore(directory).adopt(),
    ]);
    expect([...left, ...right]).toEqual([entry("race")]);
  });

  it("sets aside an unreadable queue and reports it", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "bad.json"), "{ not json");
    const exited = { pid: exitedPid(), boot: bootSeconds(), instance: "exited" };
    await writeForeign(directory, "missing-task.json", exited, [entry("x", { task: "" })]);
    await writeForeign(directory, "bad-model.json", exited, [
      entry("y", { model: { id: "" } as never }),
    ]);
    const diagnose = vi.fn();
    await expect(new FileDelegationQueueStore(directory, diagnose).adopt()).resolves.toEqual([]);
    expect(diagnose).toHaveBeenCalledTimes(3);
    const names = await readdir(directory);
    expect(names.filter((name) => name.endsWith(".invalid"))).toHaveLength(3);
    expect(names.some((name) => name.endsWith(".json"))).toBe(false);
  });
});
