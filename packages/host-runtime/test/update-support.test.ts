import { expect, test, vi } from "vitest";
import type * as Updates from "@codexhost/update-manager";
import {
  automaticUpdateUnavailableReason,
  resolveInstalledUpdateContext,
  discoverActiveUpdateStatus,
} from "@codexhost/update-manager";
import { updateCheckResultSchema, updateStatusResultSchema } from "@codexhost/shared-contracts";
import { createHostUpdateCoordinator } from "../src/update-coordinator.js";
vi.mock("@codexhost/update-manager", async (original) => ({
  ...(await original<typeof Updates>()),
  resolveInstalledUpdateContext: vi.fn(),
  recoverUpdateOperationLock: vi.fn(),
  cleanupTerminalUpdateState: vi.fn(),
  discoverActiveUpdateStatus: vi.fn(),
}));
test.each(["npm", "windows-installer"] as const)(
  "Windows %s check/start/status share the disabled execution policy without preparing",
  async (kind) => {
    vi.mocked(resolveInstalledUpdateContext).mockResolvedValue({
      metadata: {
        version: "1.2.3",
        target: "windows-x64",
        distribution: kind === "npm" ? "npm" : "installer",
      },
      common: { stateDirectory: "/unused-private-state" },
      installation: { kind, options: {} },
    } as unknown as Updates.InstalledUpdateContext);
    vi.mocked(discoverActiveUpdateStatus).mockResolvedValue(null);
    const manager: Updates.BackgroundUpdateManager = {
      prepareNpm: vi.fn(),
      prepareWindowsInstaller: vi.fn(),
      prepareMacOsDmg: vi.fn(),
      start: vi.fn(),
      readStatus: vi.fn(),
    };
    const fetchLatest = vi.fn(async () => ({
      version: "1.2.4",
      releaseNotes: "fixture",
      releaseNotesUrl: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.2.4",
      assets: [],
    }));
    const coordinator = createHostUpdateCoordinator({
      hostRuntimePath: "/unused/host-runtime.mjs",
      platform: "win32",
      manager,
      fetchLatest,
    });
    const manual = automaticUpdateUnavailableReason("win32", kind);
    const checked = updateCheckResultSchema.parse(await coordinator.check());
    expect(checked).toMatchObject({
      updateAvailable: true,
      installationAvailable: false,
      error: manual,
      status: null,
    });
    await expect(coordinator.start()).rejects.toThrow(manual as string);
    expect(updateStatusResultSchema.parse(await coordinator.status())).toEqual({ status: null });
    vi.mocked(discoverActiveUpdateStatus).mockResolvedValue({
      statusPath: "/unused/status.json",
    } as Updates.DiscoveredUpdateStatus);
    vi.mocked(manager.readStatus).mockResolvedValue({
      schemaVersion: 1,
      version: "1.2.4",
      installation: kind,
      phase: "failed",
      updatedAt: 1,
      error: "original software restored but startup unproven",
    });
    const status = updateStatusResultSchema.parse(await coordinator.status()).status;
    expect(status).toMatchObject({ phase: "failed" });
    expect(status?.error).toContain(manual);
    expect(status?.error).toContain("startup unproven");
    expect(status?.error).not.toContain("installation preserved");
    expect(manager.prepareNpm).not.toHaveBeenCalled();
    expect(manager.prepareWindowsInstaller).not.toHaveBeenCalled();
    expect(manager.start).not.toHaveBeenCalled();
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  },
);
