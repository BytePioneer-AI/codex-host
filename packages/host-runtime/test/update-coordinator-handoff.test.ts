// Portable coordination tests; native Job/identity acceptance lives in the Windows fixture.
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type {
  BackgroundUpdateManager,
  BackgroundUpdateStatus,
  InstalledUpdateContext,
} from "@codexhost/update-manager";
import { resolveInstalledUpdateContext } from "@codexhost/update-manager";
import type * as UpdateManager from "@codexhost/update-manager";
import { createHostUpdateCoordinator } from "../src/update-coordinator.js";

vi.mock("@codexhost/update-manager", async (importOriginal) => ({
  ...(await importOriginal<typeof UpdateManager>()),
  resolveInstalledUpdateContext: vi.fn(),
  // Exercise delegation coordination below the production eligibility gate.
  // This test-local substitute cannot enable any installed build.
  automaticUpdateUnavailableReason: vi.fn(() => null),
  // Isolate original-owner release from recovery's separate platform rules.
  recoverUpdateOperationLock: vi.fn(async () => {}),
}));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-delegation-"));
  roots.push(root);
  const state = path.join(root, "updates");
  vi.mocked(resolveInstalledUpdateContext).mockResolvedValue({
    metadata: { version: "1.2.2", target: "windows-x64", distribution: "npm" },
    common: { stateDirectory: state },
    installation: { kind: "npm", options: {} },
  } as unknown as InstalledUpdateContext);
  let counter = 0,
    statusPath = "";
  const manager: BackgroundUpdateManager = {
    prepareNpm: vi.fn<BackgroundUpdateManager["prepareNpm"]>(async (options) => {
      const directory = path.join(state, `update-${++counter}`);
      await mkdir(directory, { recursive: true });
      statusPath = path.join(directory, "status-v1.json");
      await writeFile(
        statusPath,
        JSON.stringify({
          schemaVersion: 1,
          version: "1.2.3",
          installation: "npm",
          phase: "prepared",
          updatedAt: 1,
        }),
      );
      await options.onPrepared?.({ version: "1.2.3", installation: "npm", statusPath });
      return {
        version: "1.2.3",
        installation: "npm",
        statusPath,
        requestPath: path.join(directory, "request-v1.json"),
        helperPath: path.join(directory, "codexhost-updater.exe"),
      };
    }),
    prepareWindowsInstaller: vi.fn(),
    prepareMacOsDmg: vi.fn(),
    start: vi.fn(async (prepared) => prepared), // delegated intent, NOT a ready acknowledgement
    readStatus: async (file) => JSON.parse(await readFile(file, "utf8")) as BackgroundUpdateStatus,
  };
  const coordinator = createHostUpdateCoordinator({
    hostRuntimePath: path.join(root, "host-runtime.mjs"),
    platform: "win32",
    manager,
    fetchLatest: async () => ({
      version: "1.2.3",
      releaseNotes: "fixture",
      releaseNotesUrl: "https://example.test/release",
      assets: [],
    }),
  });
  await coordinator.start();
  const fail = async () => {
    const value = JSON.parse(await readFile(statusPath, "utf8"));
    await writeFile(
      statusPath,
      JSON.stringify({
        ...value,
        phase: "failed",
        error: "Launcher rejected helper before handoff",
      }),
    );
  };
  return { coordinator, manager, fail, lockPath: path.join(state, "active-update-v1.lock") };
}
test("a Launcher-reported pre-handoff failure releases only this live Host's preparation lock", async () => {
  const f = await fixture();
  expect(JSON.parse(await readFile(f.lockPath, "utf8")).ownerPid).toBe(process.pid);
  await f.fail();
  expect((await f.coordinator.status()).status?.phase).toBe("failed");
  await expect(readFile(f.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
});
test("retry after delegated failure works even before the UI polls status", async () => {
  const f = await fixture();
  await f.fail();
  await f.coordinator.start();
  expect(f.manager.prepareNpm).toHaveBeenCalledTimes(2);
  expect((await f.coordinator.status()).status?.phase).toBe("prepared");
});
test("failed status cannot release an Updater-transferred or later operation", async () => {
  const f = await fixture();
  const original = JSON.parse(await readFile(f.lockPath, "utf8"));
  const transferred = JSON.stringify({
    ...original,
    ownerPid: 99999,
    ownerStartedAtMicros: "12345678901234567",
    installationStarted: true,
  });
  await writeFile(f.lockPath, transferred);
  await f.fail();
  await f.coordinator.status();
  expect(await readFile(f.lockPath, "utf8")).toBe(transferred);
});
test("native unwritten-lock cleanup before status polling is idempotent", async () => {
  const f = await fixture();
  await f.fail();
  await rm(f.lockPath);
  expect((await f.coordinator.status()).status?.phase).toBe("failed");
});
