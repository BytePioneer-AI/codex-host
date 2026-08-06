import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireUpdateOperationLock,
  cleanupTerminalUpdateState,
  discoverLatestUpdateStatus,
  recoverUpdateOperationLock,
} from "@codexhost/update-manager";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

async function status(
  root: string,
  name: string,
  phase: "prepared" | "succeeded" | "failed",
  updatedAt: number,
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
      ...(phase === "failed" ? { error: "permission denied" } : {}),
    }),
  );
  return statusPath;
}

describe("update operation state", () => {
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
