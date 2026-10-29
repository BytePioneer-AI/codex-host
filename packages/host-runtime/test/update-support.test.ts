// Coordination effects only; native ownership and material checks are not replaced in production.
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type * as Updates from "@codexhost/update-manager";
import {
  resolveInstalledUpdateContext,
  windowsInstallerRecoveryUnavailable,
} from "@codexhost/update-manager";
import { createHostUpdateCoordinator } from "../src/update-coordinator.js";
vi.mock("@codexhost/update-manager", async (original) => ({
  ...(await original<typeof Updates>()),
  resolveInstalledUpdateContext: vi.fn(),
  windowsInstallerRecoveryUnavailable: vi.fn(async () => null),
}));
test("a fresh updated/restored Host reads only its bound result, even offline and without the released lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-restarted-result-"));
  try {
    const state = path.join(root, "state"),
      op = path.join(state, "update-1.2.4-this"),
      statusPath = path.join(op, "status-v1.json"),
      descriptor = path.join(root, "runtime.json");
    await mkdir(op, { recursive: true });
    await writeFile(
      path.join(op, "request-v1.json"),
      JSON.stringify({
        schema_version: 1,
        version: "1.2.4",
        wait_pid: 999,
        status_path: statusPath,
        runtime_descriptor_path: descriptor,
        installation: { kind: "windows-installer", install_root: root },
      }),
    );
    for (const outcome of ["updated", "restored"] as const) {
      const version = outcome === "updated" ? "1.2.4" : "1.2.3";
      const context = {
        metadata: { version, target: "windows-x64", distribution: "installer" },
        common: {
          stateDirectory: state,
          runtimeDescriptorPath: descriptor,
          launcherPid: process.pid,
          launcherStartedAtMicros: "123456",
        },
        installation: { kind: "windows-installer", options: { installRoot: root } },
      } as unknown as Updates.InstalledUpdateContext;
      vi.mocked(resolveInstalledUpdateContext).mockResolvedValue(context);
      await writeFile(
        statusPath,
        JSON.stringify({
          schemaVersion: 1,
          version: "1.2.4",
          installation: "windows-installer",
          phase: outcome === "updated" ? "succeeded" : "failed",
          outcome,
          updatedAt: 1,
          restart: {
            installationRoot: root,
            launcherPid: process.pid,
            launcherStartedAtMicros: "123456",
            version,
          },
        }),
      );
      const options = {
        hostRuntimePath: path.join(root, "app/host-runtime.mjs"),
        platform: "win32" as const,
        fetchLatest: async () => {
          throw new Error("offline");
        },
      };
      const restarted = createHostUpdateCoordinator(options);
      expect((await restarted.status()).status).toMatchObject({ outcome });
      expect((await restarted.check()).status).toMatchObject({ outcome });
      expect(JSON.parse(await readFile(statusPath, "utf8")).outcome).toBe(outcome);
      const otherOperation = path.join(state, "update-1.2.5-other");
      await mkdir(otherOperation, { recursive: true });
      const otherStatus = path.join(otherOperation, "status-v1.json");
      await writeFile(
        otherStatus,
        JSON.stringify({
          schemaVersion: 1,
          version: "1.2.5",
          installation: "windows-installer",
          phase: "prepared",
          updatedAt: 2,
        }),
      );
      await writeFile(
        path.join(state, "active-update-v1.lock"),
        JSON.stringify({ ownerPid: process.pid, statusPath: otherStatus }),
      );
      await expect(restarted.start()).rejects.toThrow("Another update operation is already active");
      await rm(path.join(state, "active-update-v1.lock"));
      await rm(otherOperation, { recursive: true });
      vi.mocked(resolveInstalledUpdateContext).mockResolvedValue({
        ...context,
        common: { ...context.common, launcherPid: process.pid + 1 },
      });
      expect(await createHostUpdateCoordinator(options).status()).toEqual({ status: null });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["npm", "windows-installer"] as const)(
  "Windows %s check/start enters the existing prepare and handoff route",
  async (kind) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "host-win-start-"));
    try {
      vi.mocked(windowsInstallerRecoveryUnavailable).mockResolvedValue(null);
      const state = path.join(root, "state"),
        statusPath = path.join(state, "update-1.2.4-test/status-v1.json");
      const status = {
        schemaVersion: 1 as const,
        version: "1.2.4",
        installation: kind,
        phase: "prepared" as const,
        updatedAt: 1,
      };
      const prepare = vi.fn(async (options: Updates.CommonUpdateOptions) => {
        await mkdir(path.dirname(statusPath), { recursive: true });
        await writeFile(statusPath, JSON.stringify(status));
        await options.onPrepared?.({ version: status.version, installation: kind, statusPath });
        return {
          version: status.version,
          installation: kind,
          statusPath,
          requestPath: path.join(path.dirname(statusPath), "request-v1.json"),
          helperPath: path.join(root, "helper.exe"),
        };
      });
      const manager: Updates.BackgroundUpdateManager = {
        prepareNpm: prepare,
        prepareWindowsInstaller: prepare,
        prepareMacOsDmg: vi.fn(),
        start: vi.fn(async (p) => p),
        readStatus: async (file) => JSON.parse(await readFile(file, "utf8")),
      };
      vi.mocked(resolveInstalledUpdateContext).mockResolvedValue({
        metadata: {
          version: "1.2.3",
          target: "windows-x64",
          distribution: kind === "npm" ? "npm" : "installer",
        },
        common: {
          stateDirectory: state,
          runtimeDescriptorPath: path.join(root, "runtime.json"),
          launcherPid: 1234,
          launcherStartedAtMicros: "123",
        },
        installation: {
          kind,
          options: {
            installRoot: root,
            npmLauncherPath: path.join(root, "node_modules/@codexhost/cli/bin/codexhost.js"),
          },
        },
      } as unknown as Updates.InstalledUpdateContext);
      const coordinator = createHostUpdateCoordinator({
        hostRuntimePath: path.join(root, "app/host-runtime.mjs"),
        platform: "win32",
        manager,
        fetchLatest: async () => ({
          version: "1.2.4",
          releaseNotes: null,
          releaseNotesUrl: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.2.4",
          assets: [
            {
              name: "codexhost-1.2.4-windows-x64.exe",
              size: 10,
              digest: `sha256:${"ab".repeat(32)}`,
              downloadUrl:
                "https://github.com/BytePioneer-AI/codex-host/releases/download/v1.2.4/codexhost-1.2.4-windows-x64.exe",
            },
          ],
        }),
      });
      expect(await coordinator.check()).toMatchObject({ installationAvailable: true, error: null });
      expect(await coordinator.start()).toMatchObject({ status: { phase: "prepared" } });
      await vi.waitFor(() => expect(manager.start).toHaveBeenCalledOnce());
      expect(prepare).toHaveBeenCalledOnce();
      vi.mocked(windowsInstallerRecoveryUnavailable).mockResolvedValue(
        "Use original installer and original directory: recovery capability missing",
      );
      if (kind === "windows-installer") {
        expect(await coordinator.check()).toMatchObject({
          installationAvailable: false,
          error: expect.stringContaining("original directory"),
        });
        await expect(coordinator.start()).rejects.toThrow("original directory");
        expect(prepare).toHaveBeenCalledOnce();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
