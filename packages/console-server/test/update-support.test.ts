import { expect, test, vi } from "vitest";
import type * as Updates from "@codexhost/update-manager";
import {
  automaticUpdateUnavailableReason,
  discoverActiveUpdateStatus,
} from "@codexhost/update-manager";
import { updateCheckResultSchema, updateStatusResultSchema } from "@codexhost/shared-contracts";
import { createConsoleUpdates } from "../src/updates.js";
import { runUpdateCommand } from "../src/update-cli.js";
vi.mock("@codexhost/update-manager", async (original) => ({
  ...(await original<typeof Updates>()),
  recoverUpdateOperationLock: vi.fn(),
  cleanupTerminalUpdateState: vi.fn(),
  discoverActiveUpdateStatus: vi.fn(),
}));
test.each(["npm", "windows-installer"] as const)(
  "Windows %s console and CLI offer manual original-channel update, no false handoff",
  async (kind) => {
    vi.mocked(discoverActiveUpdateStatus).mockResolvedValue(null);
    const manager: Updates.BackgroundUpdateManager = {
      prepareNpm: vi.fn(),
      prepareWindowsInstaller: vi.fn(),
      prepareMacOsDmg: vi.fn(),
      start: vi.fn(),
      readStatus: vi.fn(),
    };
    const handedOff = vi.fn();
    const updates = createConsoleUpdates({
      platform: "win32",
      stateDirectory: "/unused-private-state",
      manager,
      onHandedOff: handedOff,
      fetchLatest: async () => ({
        version: "1.2.4",
        releaseNotes: "fixture",
        releaseNotesUrl: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.2.4",
        assets: [],
      }),
    });
    const target = {
      distribution: {
        schemaVersion: 1 as const,
        version: "1.2.3",
        target: "windows-x64" as const,
        distribution: kind === "npm" ? ("npm" as const) : ("installer" as const),
      },
      appDirectory: "/unused/app",
      runtimeDescriptorPath: "/unused/runtime.json",
      codexhostRunning: true,
    };
    const manual = automaticUpdateUnavailableReason("win32", kind);
    expect(updateCheckResultSchema.parse(await updates.check(target))).toMatchObject({
      updateAvailable: true,
      installationAvailable: false,
      error: manual,
      status: null,
    });
    await expect(updates.start(target)).rejects.toMatchObject({
      code: "unsupported",
      message: manual,
    });
    const output = vi.fn();
    await expect(runUpdateCommand(target, updates, output)).rejects.toThrow(manual as string);
    expect(output).toHaveBeenCalledTimes(1);
    expect(updateStatusResultSchema.parse(await updates.status())).toEqual({ status: null });
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
    const status = updateStatusResultSchema.parse(await updates.status()).status;
    expect(status?.phase).toBe("failed");
    expect(status?.error).toContain(manual);
    expect(status?.error).toContain("startup unproven");
    expect(status?.error).not.toContain("installation preserved");
    expect(manager.prepareNpm).not.toHaveBeenCalled();
    expect(manager.prepareWindowsInstaller).not.toHaveBeenCalled();
    expect(manager.start).not.toHaveBeenCalled();
    expect(handedOff).not.toHaveBeenCalled();
  },
);
