import { describe, expect, it, vi } from "vitest";
import { runUpdateCommand, updateFromCommand } from "../src/update-cli.js";
import type { ConsoleUpdates, ConsoleUpdateTarget } from "../src/updates.js";

const target: ConsoleUpdateTarget = {
  distribution: null,
  appDirectory: "/unused",
  runtimeDescriptorPath: null,
  codexhostRunning: false,
};

function fixture() {
  const check = vi.fn<ConsoleUpdates["check"]>().mockResolvedValue({
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    installation: "npm",
    updateAvailable: true,
    installationAvailable: true,
    releaseNotes: null,
    releaseNotesUrl: null,
    status: null,
    error: null,
  });
  const start = vi.fn<ConsoleUpdates["start"]>().mockResolvedValue({
    status: {
      version: "1.1.0",
      installation: "npm",
      phase: "prepared",
      updatedAt: 1,
      error: null,
    },
  });
  return { check, start, status: vi.fn<ConsoleUpdates["status"]>() };
}

describe("update command", () => {
  it("checks and prepares an upgrade without claiming installation succeeded", async () => {
    const updates = fixture();
    const write = vi.fn();
    await runUpdateCommand(target, updates, write);
    expect(updates.start).toHaveBeenCalledWith(target);
    expect(write).toHaveBeenLastCalledWith(expect.stringContaining("background updater"));
  });

  it("does not start an update when already current", async () => {
    const updates = fixture();
    const checked = await updates.check(target);
    updates.check.mockResolvedValue({ ...checked, updateAvailable: false });
    const write = vi.fn();
    await runUpdateCommand(target, updates, write);
    expect(updates.start).not.toHaveBeenCalled();
    expect(write).toHaveBeenLastCalledWith("codexhost 1.0.0 is up to date.");
  });

  it("propagates check and preparation errors", async () => {
    const updates = fixture();
    const checked = await updates.check(target);
    updates.check.mockResolvedValueOnce({ ...checked, error: "Network unavailable" });
    await expect(runUpdateCommand(target, updates, vi.fn())).rejects.toThrow("Network unavailable");
    expect(updates.start).not.toHaveBeenCalled();
    updates.start.mockRejectedValue(new Error("Quit Codex Desktop first"));
    await expect(runUpdateCommand(target, updates, vi.fn())).rejects.toThrow("Quit Codex Desktop");
  });

  it("points to Codex settings or a manual install when the terminal cannot install", async () => {
    const updates = fixture();
    const checked = await updates.check(target);
    updates.check.mockResolvedValue({
      ...checked,
      installationAvailable: false,
      releaseNotesUrl: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.1.0",
    });
    await expect(runUpdateCommand(target, updates, vi.fn())).rejects.toThrow(
      "codexhost 1.1.0 is available but cannot be installed from the terminal here. Update from Codex settings, or install the release manually (https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.1.0).",
    );
    expect(updates.start).not.toHaveBeenCalled();
  });

  it("rejects unknown arguments before inspecting or updating", async () => {
    await expect(updateFromCommand("/unused", ["extra"])).rejects.toThrow("accepts no arguments");
  });
});
