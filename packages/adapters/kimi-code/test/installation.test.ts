import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  fetch: vi.fn(),
  npm: vi.fn(),
  resolve: vi.fn(),
  open: vi.fn(),
}));
vi.mock("@codexhost/harness-discovery", async (original) => ({
  ...(await original<object>()),
  runInstallationCommand: mocks.run,
  fetchInstallationText: mocks.fetch,
  npmInstallation: mocks.npm,
}));
vi.mock("../src/command.js", () => ({ resolveKimiExecutable: mocks.resolve }));
vi.mock("node:fs/promises", () => ({ readFile: async () => "global", open: mocks.open }));
import { createKimiInstallation } from "../src/installation.js";

describe("Kimi native version maintenance", () => {
  it("updates a recognized npm installation and confirms its new version", async () => {
    mocks.resolve.mockReturnValue("/chosen/kimi");
    mocks.fetch.mockResolvedValue("0.42.1");
    let version = "0.42.0";
    mocks.run.mockImplementation(async () => version);
    const update = vi.fn(async () => {
      version = "0.42.1";
    });
    mocks.npm.mockResolvedValue({ canUpdate: true, update });
    await expect(createKimiInstallation({})("update")).resolves.toMatchObject({
      currentVersion: "0.42.1",
      updateAvailable: false,
    });
    expect(update).toHaveBeenCalledWith("0.42.1");
    expect(mocks.fetch).toHaveBeenCalledWith("https://code.kimi.ai/kimi-code/latest");
  });
  it("does not stage an update for an unknown script installation", async () => {
    mocks.resolve.mockReturnValue("/chosen/kimi");
    mocks.fetch.mockResolvedValue("0.42.1");
    mocks.run.mockResolvedValue("0.42.0");
    mocks.npm.mockResolvedValue(null);
    const close = vi.fn();
    mocks.open.mockResolvedValue({
      read: async (buffer: Buffer) => {
        buffer.write("#!sh");
      },
      close,
    });
    const installation = createKimiInstallation({});
    await expect(installation("check")).resolves.toMatchObject({
      canUpdate: false,
      updateAvailable: true,
    });
    await expect(installation("update")).rejects.toThrow("original installer");
    expect(close).toHaveBeenCalled();
  });
});
