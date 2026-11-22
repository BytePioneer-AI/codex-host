import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireUpdateOperationLock,
  cleanupTerminalUpdateState,
  discoverLatestUpdateStatus,
  discoverRecentCompletedUpdateStatus,
  isUpdateOperationActive,
  recoverUpdateOperationLock,
} from "@codexhost/update-manager";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

async function status(
  root: string,
  name: string,
  phase: "prepared" | "succeeded" | "failed",
  updatedAt: number,
  serviceStopOutput?: string,
): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  const statusPath = path.join(directory, "status-v1.json");
  await writeFile(
    statusPath,
    JSON.stringify({
      schemaVersion: 1,
      version: "1.2.3",
      installation: "npm",
      phase,
      updatedAt,
      ...(serviceStopOutput === undefined ? {} : { serviceStopOutput }),
      ...(phase === "failed" ? { error: "permission denied" } : {}),
    }),
  );
  return statusPath;
}

describe("update operation state", () => {
  it("transfers the prepared operation to the updater without releasing its lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-update-transfer-"));
    roots.push(root);
    const operation = await acquireUpdateOperationLock(root);
    if (!operation) throw new Error("Missing operation lock");
    await expect(operation.transferTo(process.pid)).rejects.toThrow("not prepared");
    const statusPath = await status(root, "update-active", "prepared", 20);
    await operation.setStatusPath(statusPath);
    await expect(operation.transferTo(0)).rejects.toThrow("Invalid update owner PID");
    await operation.transferTo(process.ppid);
    expect(JSON.parse(await readFile(operation.path, "utf8"))).toEqual({
      ownerPid: process.ppid,
      statusPath,
    });
    await recoverUpdateOperationLock(root);
    expect(await acquireUpdateOperationLock(root)).toBeNull();
    await operation.release();
  });
  it("recovers a crashed remote updater lock but preserves a live remote updater", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-update-remote-"));
    roots.push(root);
    const lock = path.join(root, "active-update-v1.lock");
    await writeFile(
      lock,
      JSON.stringify({ ownerPid: process.pid, statusPath: null, remoteUpdate: true }),
    );
    await recoverUpdateOperationLock(root);
    expect(await isUpdateOperationActive(root)).toBe(true);
    await writeFile(
      lock,
      JSON.stringify({ ownerPid: 999_999_999, statusPath: null, remoteUpdate: true }),
    );
    await recoverUpdateOperationLock(root);
    expect(await isUpdateOperationActive(root)).toBe(false);
  });

  it("discovers the latest valid status and ignores malformed state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-update-state-"));
    roots.push(root);
    await status(root, "update-old", "succeeded", 10);
    const latest = await status(root, "update-new", "failed", 20);
    await mkdir(path.join(root, "update-malformed"));
    await writeFile(path.join(root, "update-malformed", "status-v1.json"), "{}");
    await expect(discoverLatestUpdateStatus(root)).resolves.toMatchObject({
      statusPath: latest,
      status: { phase: "failed", error: "permission denied" },
    });
  });

  it.each([
    { phase: "succeeded", age: 0, output: "opaque\n", restore: true },
    { phase: "failed", age: 86_400, output: "opaque\n", restore: true },
    { phase: "succeeded", age: 86_401, output: "opaque\n", restore: false },
    { phase: "failed", age: 86_401, output: "opaque\n", restore: false },
    { phase: "succeeded", age: 0, output: "", restore: true },
    { phase: "failed", age: 0, output: undefined, restore: true },
    { phase: "prepared", age: 0, output: "opaque\n", restore: false },
  ] as const)(
    "restores the recent completed status with optional output: $phase/$age/$output",
    async ({ phase, age, output, restore }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-recent-update-"));
      roots.push(root);
      const now = 1_800_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
      try {
        const statusPath = await status(root, "update-result", phase, now - age, output);
        const result = await discoverRecentCompletedUpdateStatus(root);
        if (restore) {
          expect(result).toMatchObject({ statusPath, status: { phase } });
          expect(result?.status.serviceStopOutput).toBe(output);
        } else expect(result).toBeNull();
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("does not resurrect an older output when the latest update has none", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-recent-update-"));
    roots.push(root);
    const now = Math.floor(Date.now() / 1000);
    await status(root, "update-old", "failed", now - 10, "old failure output\n");
    await status(root, "update-latest", "succeeded", now, "");
    await expect(discoverRecentCompletedUpdateStatus(root)).resolves.toMatchObject({
      status: { phase: "succeeded", serviceStopOutput: "" },
    });
  });

  it("reports whether a live operation lock exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-update-active-"));
    roots.push(root);
    await expect(isUpdateOperationActive(root)).resolves.toBe(false);
    const lock = await acquireUpdateOperationLock(root);
    if (!lock) throw new Error("operation lock was not acquired");
    await expect(isUpdateOperationActive(root)).resolves.toBe(true);
    await lock.release();
    await expect(isUpdateOperationActive(root)).resolves.toBe(false);
  });

  it("allows only one atomic operation lock and recovers it after terminal status", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-update-lock-"));
    roots.push(root);
    const first = await acquireUpdateOperationLock(root);
    if (!first) throw new Error("first update operation lock was not acquired");
    await expect(acquireUpdateOperationLock(root)).resolves.toBeNull();
    const statusPath = await status(root, "update-one", "succeeded", 20);
    await first.setStatusPath(statusPath);
    await recoverUpdateOperationLock(root);
    const second = await acquireUpdateOperationLock(root);
    if (!second) throw new Error("recovered update operation lock was not acquired");
    await second.release();
  });

  it("recovers a nonterminal operation after its transferred owner exits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-update-dead-owner-"));
    roots.push(root);
    const statusPath = await status(root, "update-dead", "prepared", 20);
    await writeFile(
      path.join(root, "active-update-v1.lock"),
      `${JSON.stringify({ ownerPid: 999_999_999, statusPath })}\n`,
    );

    await recoverUpdateOperationLock(root);
    const recovered = await acquireUpdateOperationLock(root);
    if (!recovered) throw new Error("dead owner operation lock was not recovered");
    await recovered.release();
  });

  it("cleans only old terminal operation directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-update-clean-"));
    roots.push(root);
    await status(root, "update-old", "succeeded", 10);
    await status(root, "update-active", "prepared", 10);
    await cleanupTerminalUpdateState(root, { now: 20_000_000, retentionSeconds: 100 });
    await expect(discoverLatestUpdateStatus(root)).resolves.toMatchObject({
      status: { phase: "prepared" },
    });
  });
});
