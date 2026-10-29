import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireUpdateOperationLock,
  cleanupTerminalUpdateState,
  discoverLatestUpdateStatus,
  isUpdateOperationActive,
  recoverUpdateOperationLock,
} from "@codexhost/update-manager";

import { openMutationGuard } from "../src/operation-guard.js";

const nativeGuardPlatform = process.platform === "win32" || process.platform === "darwin";
const heldFixtureGuards = new Set<string>();
const openFixtureGuard: typeof openMutationGuard = nativeGuardPlatform
  ? openMutationGuard
  : async (file) => {
      // Linux has no Node file-lock primitive; these Windows state-machine units use
      // an injected guard. Native process-lifetime tests run only on Windows/macOS.
      if (heldFixtureGuards.has(file))
        throw Object.assign(new Error("busy fixture guard"), { code: "EAGAIN" });
      heldFixtureGuards.add(file);
      return {
        async close() {
          heldFixtureGuards.delete(file);
        },
      };
    };

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

async function status(
  root: string,
  name: string,
  phase: "prepared" | "succeeded" | "failed" | "installing" | "waiting-for-exit" | "restarting",
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
    if (process.platform === "win32") await first.release();
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

  const windowsOptions = {
    platform: "win32" as const,
    openMutationGuard: openFixtureGuard,
    readProcessIdentity: async () => ({
      executable: process.execPath,
      startedAtMicros: "123456789",
    }),
  };

  it("serializes Windows lock mutation with the native helper's filesystem guard", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-mutation-guard-"));
    roots.push(root);
    const guard = await openFixtureGuard(path.join(root, ".active-update-mutation.lock"));
    const pending = acquireUpdateOperationLock(root, windowsOptions);
    try {
      await delay(40);
      expect(await isUpdateOperationActive(root)).toBe(false);
    } finally {
      await guard.close();
    }
    const lock = await pending;
    if (!lock) throw new Error("lock missing");
    await lock.release();
  });

  it
    .skipIf(!nativeGuardPlatform)
    .each(["identity", "record-write", "after-acquire", "status-write"] as const)(
    "can retry after a real preparation process exits during %s",
    async (stage) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-guard-crash-"));
      roots.push(root);
      const entry = pathToFileURL(path.resolve(import.meta.dirname, "../dist/index.js")).href;
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import * as fs from "node:fs/promises";
           import { acquireUpdateOperationLock } from ${JSON.stringify(entry)};
           const root = ${JSON.stringify(root)};
           const stage = ${JSON.stringify(stage)};
           await fs.writeFile(root + "/probe", "fixture");
           const probe = await fs.open(root + "/probe");
           const prototype = Object.getPrototypeOf(probe);
           const write = prototype.writeFile;
           await probe.close();
           prototype.writeFile = async function(data, ...rest) {
             if (typeof data === "string" && data.includes('"operationId"')) {
               const record = JSON.parse(data);
               if ((stage === "record-write" && record.statusPath === null) || (stage === "status-write" && record.statusPath !== null)) {
                 await write.call(this, data.slice(0, 5), ...rest);
                 process.exit(23);
               }
             }
             return write.call(this, data, ...rest);
           };
           const lock = await acquireUpdateOperationLock(root, { platform: "win32", readProcessIdentity: async () => {
             if (stage === "identity") process.exit(23);
             return { executable: process.execPath, startedAtMicros: "123456789" };
           }});
           if (stage === "after-acquire") process.exit(23);
           if (stage === "status-write") {
             const statusPath = root + "/status-v1.json";
             await fs.writeFile(statusPath, JSON.stringify({ schemaVersion:1, version:"1.2.3", installation:"npm", phase:"prepared", updatedAt:1 }));
             await lock.setStatusPath(statusPath);
           }
           throw new Error("fixture did not reach crash point");`,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(child.status, child.stderr).toBe(23);
      expect(await isUpdateOperationActive(root)).toBe(
        stage === "after-acquire" || stage === "status-write",
      );
      expect((await readFile(path.join(root, ".active-update-mutation.lock"))).length).toBe(0);
      await recoverUpdateOperationLock(root, windowsOptions);
      expect(await isUpdateOperationActive(root)).toBe(false);
      const next = await acquireUpdateOperationLock(root, windowsOptions);
      expect(next).not.toBeNull();
      await next?.release();
    },
  );

  it.skipIf(!nativeGuardPlatform)(
    "never breaks a live process's guard and acquires it after abrupt termination",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-live-guard-"));
      roots.push(root);
      const entry = pathToFileURL(path.resolve(import.meta.dirname, "../dist/index.js")).href;
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { acquireUpdateOperationLock } from ${JSON.stringify(entry)}; setInterval(() => {}, 1000); await acquireUpdateOperationLock(${JSON.stringify(root)}, { platform: "win32", readProcessIdentity: async () => { process.stdout.write("held"); return new Promise(() => {}); } });`,
        ],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      try {
        await once(child, "spawn");
        await once(child.stdout, "data");
        let acquired = false;
        const pending = acquireUpdateOperationLock(root, windowsOptions).then((lock) => {
          acquired = true;
          return lock;
        });
        await delay(80);
        expect(acquired).toBe(false);
        const exited = once(child, "exit");
        child.kill();
        await exited;
        const next = await pending;
        expect(next).not.toBeNull();
        await next?.release();
      } finally {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill();
          await exited;
        }
      }
    },
  );

  it("does not let a stale owner release a transferred or subsequently acquired operation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-transfer-lock-"));
    roots.push(root);
    const first = await acquireUpdateOperationLock(root, windowsOptions);
    if (!first) throw new Error("lock missing");
    const statusPath = await status(root, "update-transfer", "waiting-for-exit", 20);
    await first.setStatusPath(statusPath);
    const lockPath = path.join(root, "active-update-v1.lock");
    const transferred = {
      ...JSON.parse(await readFile(lockPath, "utf8")),
      ownerPid: 42,
      ownerStartedAtMicros: "555",
    };
    await writeFile(lockPath, JSON.stringify(transferred));
    await first.release();
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(transferred);
    await recoverUpdateOperationLock(root, {
      ...windowsOptions,
      processIsAlive: () => true,
      readProcessIdentity: async () => ({ executable: "updater.exe", startedAtMicros: "555" }),
    });
    expect(await acquireUpdateOperationLock(root, windowsOptions)).toBeNull();
  });

  it("a superseded lock handle cannot remove a newer operation owned by the same PID", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-stale-release-"));
    roots.push(root);
    const first = await acquireUpdateOperationLock(root);
    if (!first) throw new Error("lock missing");
    await rm(first.path);
    const second = await acquireUpdateOperationLock(root);
    if (!second) throw new Error("second lock missing");
    await first.release();
    expect(await isUpdateOperationActive(root)).toBe(true);
    await second.release();
  });

  it.each([
    ["installing", true],
    ["restarting", true],
    ["failed", true],
    ["restarting", false],
  ] as const)(
    "retains Windows interrupted %s materials and blocks retry even after PID reuse (marker %s)",
    async (phase, installationStarted) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-interrupted-"));
      roots.push(root);
      const lock = await acquireUpdateOperationLock(root, windowsOptions);
      if (!lock) throw new Error("lock missing");
      const statusPath = await status(root, "update-interrupted", phase, 1);
      await lock.setStatusPath(statusPath);
      const value = JSON.parse(await readFile(lock.path, "utf8"));
      await writeFile(lock.path, JSON.stringify({ ...value, installationStarted }));
      await recoverUpdateOperationLock(root, {
        ...windowsOptions,
        processIsAlive: () => true,
        readProcessIdentity: async () => ({
          executable: process.execPath,
          startedAtMicros: "987654321",
        }),
      });
      expect(await isUpdateOperationActive(root)).toBe(true);
      expect(JSON.parse(await readFile(statusPath, "utf8")).phase).toBe("failed");
      await cleanupTerminalUpdateState(root, { now: 20_000_000, retentionSeconds: 1 });
      expect(await readFile(statusPath, "utf8")).toContain("failed");
    },
  );

  it.each(["failed", "installing"] as const)(
    "allows an unwritten Windows operation to retry after its exact owner exits (phase %s)",
    async (phase) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-preparation-retry-"));
      roots.push(root);
      const lock = await acquireUpdateOperationLock(root, windowsOptions);
      if (!lock) throw new Error("lock missing");
      await lock.setStatusPath(await status(root, "update-preparation", phase, 20));
      await recoverUpdateOperationLock(root, { ...windowsOptions, processIsAlive: () => false });
      expect(await isUpdateOperationActive(root)).toBe(false);
    },
  );

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
