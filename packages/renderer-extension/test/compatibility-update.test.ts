import type { UpdateCheckResult } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { startCompatibilityUpdate } from "../src/compatibility-update.js";

function updateCheck(overrides: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return {
    currentVersion: "0.1.0",
    latestVersion: "0.1.0",
    updateAvailable: false,
    installationAvailable: false,
    releaseNotes: null,
    releaseNotesUrl: null,
    status: null,
    error: null,
    ...overrides,
  };
}

describe("compatibility update", () => {
  it("starts an installable newer release", async () => {
    const startUpdate = vi.fn(() => new Promise<never>(() => {}));
    await expect(
      startCompatibilityUpdate({
        checkUpdate: vi.fn(async () =>
          updateCheck({
            latestVersion: "0.2.0",
            updateAvailable: true,
            installationAvailable: true,
          }),
        ),
        startUpdate,
      }),
    ).resolves.toBe("update-started");
    expect(startUpdate).toHaveBeenCalledOnce();
  });

  it("reports current only when the checked versions match", async () => {
    const startUpdate = vi.fn();
    await expect(
      startCompatibilityUpdate({
        checkUpdate: vi.fn(async () => updateCheck()),
        startUpdate,
      }),
    ).resolves.toBe("current");
    expect(startUpdate).not.toHaveBeenCalled();
  });

  it("keeps running when an update is unavailable or fails", async () => {
    const startUpdate = vi.fn();
    await expect(startCompatibilityUpdate(null)).resolves.toBe("unavailable");
    await expect(
      startCompatibilityUpdate({
        checkUpdate: vi.fn(async () =>
          updateCheck({
            latestVersion: "0.2.0",
            updateAvailable: true,
            installationAvailable: false,
            error: "verified artifact unavailable",
          }),
        ),
        startUpdate,
      }),
    ).resolves.toBe("unavailable");
    await expect(
      startCompatibilityUpdate({
        checkUpdate: vi.fn(async () => {
          throw new Error("private network detail");
        }),
        startUpdate,
      }),
    ).resolves.toBe("unavailable");
    expect(startUpdate).not.toHaveBeenCalled();
  });
});
