import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn(), resolve: vi.fn() }));
vi.mock("@codexhost/harness-discovery", async (original) => ({
  ...(await original<object>()),
  runInstallationCommand: mocks.run,
}));
vi.mock("../src/qoder-command.js", () => ({ resolveQoderExecutable: mocks.resolve }));
import { createQoderInstallation } from "../src/installation.js";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("Qoder native version maintenance", () => {
  it("uses native check/update and rejects unfamiliar check output", async () => {
    mocks.resolve.mockReturnValue("/chosen/qoder");
    let version = "1.0.0";
    mocks.run.mockImplementation(async (_command, args) => {
      if (args[0] === "--version") return version;
      if (args[1] === "--check")
        return version === "1.0.0" ? "Update available: 1.0.0 -> 1.1.0" : "Already on latest";
      version = "1.1.0";
      return "ok";
    });
    await expect(createQoderInstallation({})("update")).resolves.toMatchObject({
      currentVersion: "1.1.0",
      updateAvailable: false,
    });
    expect(mocks.run).toHaveBeenCalledWith("/chosen/qoder", ["update"], {}, 300_000);
    mocks.run.mockImplementation(async (_command, args) =>
      args[0] === "--version" ? "1.0.0" : "Login required",
    );
    await expect(createQoderInstallation({})("check")).rejects.toThrow("unknown response");
  });

  it("retains bounded, redacted diagnostics for unfamiliar localized check output", async () => {
    mocks.run.mockClear();
    mocks.resolve.mockReturnValue("/chosen/qoder");
    mocks.run.mockImplementation(async (_command, args) =>
      args[0] === "--version"
        ? "1.0.0"
        : `${"x".repeat(9_000)} 检查更新需要登录 api_key=private-key Authorization: Bearer private-token`,
    );
    const failure: unknown = await createQoderInstallation({})("update").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("检查更新需要登录");
    expect(message).toContain("[redacted]");
    expect(message).not.toContain("private-key");
    expect(message).not.toContain("private-token");
    expect(message.length).toBeLessThan(8_100);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(message);
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(mocks.run).toHaveBeenLastCalledWith(
      "/chosen/qoder",
      ["update", "--check"],
      {},
      undefined,
    );
  });
});
