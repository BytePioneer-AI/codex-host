import { describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "@codexhost/shared-contracts";
import { runUpdateCommand, updateFromCommand } from "../src/update-cli.js";
import type { ConsoleUpdates, ConsoleUpdateTarget } from "../src/updates.js";
import { createHostUpdates } from "../src/host-client.js";

const target: ConsoleUpdateTarget = {
  distribution: null,
  appDirectory: "/unused",
  runtimeDescriptorPath: null,
  codexhostRunning: false,
};

const prepared: UpdateStatus = {
  version: "1.1.0",
  installation: "npm",
  phase: "prepared",
  updatedAt: 1,
  error: null,
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
  const start = vi.fn<ConsoleUpdates["start"]>().mockResolvedValue({ status: prepared });
  return {
    check,
    start,
    status: vi.fn<ConsoleUpdates["status"]>().mockResolvedValue({ status: null }),
  };
}

describe("update command", () => {
  it("uses the running Host operation without starting a separate updater", async () => {
    const updates = fixture();
    const request = vi.fn(async (method: string) => ({
      result: method.endsWith("check") ? await updates.check(target) : await updates.start(target),
    }));
    const host = createHostUpdates({ available: async () => true, request });
    await runUpdateCommand(target, host, vi.fn());
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "codexhost/update/check",
      "codexhost/update/start",
    ]);
  });
  it("checks and prepares an upgrade without claiming installation succeeded", async () => {
    const updates = fixture();
    const write = vi.fn();
    await runUpdateCommand(target, updates, write);
    expect(updates.start).toHaveBeenCalledWith(target);
    expect(write).toHaveBeenLastCalledWith(expect.stringContaining("background updater"));
  });

  it("follows an accepted npm download until the packages are ready", async () => {
    const updates = fixture();
    const downloading: UpdateStatus = { ...prepared, phase: "downloading" };
    updates.start.mockResolvedValue({
      status: { ...downloading, npmDownload: { completed: 0, total: 2 } },
    });
    updates.status
      .mockResolvedValueOnce({
        status: { ...downloading, npmDownload: { completed: 1, total: 2 } },
      })
      .mockResolvedValue({ status: prepared });
    const write = vi.fn();

    await runUpdateCommand(target, updates, write);

    expect(write.mock.calls.map(([message]) => message).slice(2)).toEqual([
      "Downloading update... 0/2 npm packages ready",
      "Downloading update... 1/2 npm packages ready",
      "Download complete.",
      expect.stringContaining("background updater"),
    ]);
  });

  it("shows byte progress while the standalone command waits for handoff", async () => {
    const updates = fixture();
    const handoff = Promise.withResolvers<Awaited<ReturnType<ConsoleUpdates["start"]>>>();
    updates.start.mockReturnValue(handoff.promise);
    const installer = { ...prepared, installation: "macos-dmg" } as const;
    updates.status.mockResolvedValue({
      status: {
        ...installer,
        phase: "downloading",
        downloadedBytes: 8 * 1024 ** 2,
        totalBytes: 16 * 1024 ** 2,
      },
    });
    const output: string[] = [];
    const command = runUpdateCommand(target, updates, (message) => {
      output.push(message);
      if (message.startsWith("Downloading update")) handoff.resolve({ status: installer });
    });

    await command;

    expect(output.slice(2)).toEqual([
      "Downloading update... 50% (8.0 MiB / 16.0 MiB)",
      "Download complete.",
      expect.stringContaining("background updater"),
    ]);
  });

  it("reports an asynchronous download failure without printing completion", async () => {
    const updates = fixture();
    updates.start.mockResolvedValue({ status: { ...prepared, phase: "downloading" } });
    updates.status.mockResolvedValue({
      status: { ...prepared, phase: "failed", error: "Registry unavailable" },
    });
    const write = vi.fn();

    await expect(runUpdateCommand(target, updates, write)).rejects.toThrow("Registry unavailable");
    expect(write.mock.calls.map(([message]) => message)).not.toContain("Download complete.");
    expect(write).toHaveBeenLastCalledWith("Downloading update...", true);
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

  it("does not start an update the npm registry cannot install yet", async () => {
    const updates = fixture();
    const checked = await updates.check(target);
    updates.check.mockResolvedValue({ ...checked, installationAvailable: false });
    await expect(runUpdateCommand(target, updates, vi.fn())).rejects.toThrow(
      "your npm registry does not have it yet",
    );
    expect(updates.start).not.toHaveBeenCalled();
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

  it("rejects unknown arguments before inspecting or updating", async () => {
    await expect(updateFromCommand("/unused", ["extra"])).rejects.toThrow("accepts no arguments");
  });
});
