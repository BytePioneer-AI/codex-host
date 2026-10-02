import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  npm: vi.fn(),
  resolve: vi.fn(),
  update: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("@codexhost/harness-discovery", async (original) => ({
  ...(await original<object>()),
  runInstallationCommand: mocks.run,
  npmInstallation: mocks.npm,
  fetchInstallationText: mocks.fetch,
}));
vi.mock("../src/executable.js", () => ({ resolveDeepSeekCommand: mocks.resolve }));
import { createDeepSeekInstallation } from "../src/installation.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockReturnValue({ command: "/chosen/dsh", arguments: [], kind: "dsh" });
  mocks.run.mockResolvedValue("0.2.0-rc.2");
  mocks.fetch.mockResolvedValue(JSON.stringify({ version: "0.2.0-rc.3" }));
});

describe("DeepSeek installation", () => {
  it("updates identified global npm installs including newer prereleases", async () => {
    mocks.npm.mockResolvedValue({
      canUpdate: true,
      latest: async () => "0.2.0-rc.3",
      update: mocks.update,
    });
    mocks.update.mockImplementation(async () => mocks.run.mockResolvedValue("0.2.0-rc.3"));
    await expect(createDeepSeekInstallation({}, "/chosen/dsh")("update")).resolves.toMatchObject({
      currentVersion: "0.2.0-rc.3",
      updateAvailable: false,
    });
    expect(mocks.npm).toHaveBeenCalledWith("/chosen/dsh", ["@deepseek-ai/dsh"], {});
    expect(mocks.update).toHaveBeenCalledWith("0.2.0-rc.3");
  });

  it("queries latest independently while preserving the offline npx version probe", async () => {
    mocks.resolve.mockReturnValue({
      command: "/chosen/npx",
      arguments: ["--offline", "--no-install", "@deepseek-ai/dsh"],
      kind: "npx",
    });
    await expect(createDeepSeekInstallation({})("check")).resolves.toMatchObject({
      currentVersion: "0.2.0-rc.2",
      latestVersion: "0.2.0-rc.3",
      canUpdate: true,
      updateAvailable: true,
    });
    expect(mocks.run).toHaveBeenCalledWith(
      "/chosen/npx",
      ["--offline", "--no-install", "@deepseek-ai/dsh", "--version"],
      {},
    );
    expect(mocks.npm).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://registry.npmjs.org/%40deepseek-ai%2Fdsh/latest",
    );
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  describe("npx updates", () => {
    beforeEach(() => {
      mocks.resolve.mockReturnValue({
        command: "/chosen/npx",
        arguments: ["--offline", "--no-install", "@deepseek-ai/dsh"],
        kind: "npx",
      });
    });

    it("updates the original cache and confirms the offline launch version", async () => {
      mocks.run.mockResolvedValueOnce("0.2.0-rc.2").mockResolvedValue("0.2.0-rc.3");
      const environment = { npm_config_cache: "/chosen/cache" };
      await expect(createDeepSeekInstallation(environment)("update")).resolves.toMatchObject({
        currentVersion: "0.2.0-rc.3",
        canUpdate: true,
        updateAvailable: false,
      });
      expect(mocks.run).toHaveBeenNthCalledWith(
        2,
        "/chosen/npx",
        ["--yes", "--prefer-online", "@deepseek-ai/dsh", "--version"],
        environment,
        600_000,
      );
      expect(mocks.run).toHaveBeenNthCalledWith(
        3,
        "/chosen/npx",
        ["--offline", "--no-install", "@deepseek-ai/dsh", "--version"],
        environment,
      );
      expect(mocks.npm).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    });

    it("does not download when the current version is already latest", async () => {
      mocks.fetch.mockResolvedValue(JSON.stringify({ version: "0.2.0-rc.2" }));
      await expect(createDeepSeekInstallation({})("update")).resolves.toMatchObject({
        updateAvailable: false,
      });
      expect(mocks.run).toHaveBeenCalledOnce();
    });

    it("rejects a download that still selects the old version", async () => {
      await expect(createDeepSeekInstallation({})("update")).rejects.toThrow("requested version");
      expect(mocks.run).toHaveBeenCalledTimes(2);
    });

    it("rejects success when the subsequent offline launch still selects an old cache", async () => {
      mocks.run
        .mockResolvedValueOnce("0.2.0-rc.2")
        .mockResolvedValueOnce("0.2.0-rc.3")
        .mockResolvedValueOnce("0.2.0-rc.2");
      await expect(createDeepSeekInstallation({})("update")).rejects.toThrow("offline npx launch");
    });

    it("shares concurrent updates and allows retry after download failure", async () => {
      mocks.run
        .mockResolvedValueOnce("0.2.0-rc.2")
        .mockRejectedValueOnce(new Error("download failed"));
      const installation = createDeepSeekInstallation({});
      const first = installation("update");
      expect(installation("update")).toBe(first);
      await expect(first).rejects.toThrow("download failed");
      mocks.run.mockResolvedValueOnce("0.2.0-rc.2").mockResolvedValue("0.2.0-rc.3");
      await expect(installation("update")).resolves.toMatchObject({ currentVersion: "0.2.0-rc.3" });
    });

    it.each(["{}", '{"version":"not-a-version"}', "not-json"])(
      "rejects invalid registry metadata: %s",
      async (metadata) => {
        mocks.fetch.mockResolvedValue(metadata);
        await expect(createDeepSeekInstallation({})("update")).rejects.toThrow();
        expect(mocks.run).toHaveBeenCalledOnce();
      },
    );

    it("does not attempt an update when the registry request fails", async () => {
      mocks.fetch.mockRejectedValue(new Error("network unavailable"));
      await expect(createDeepSeekInstallation({})("update")).rejects.toThrow("network unavailable");
      expect(mocks.run).toHaveBeenCalledOnce();
    });
  });

  it("does not upgrade project-local, Python, or desktop installations with global npm", async () => {
    mocks.npm.mockResolvedValue({
      canUpdate: false,
      latest: async () => "0.2.0",
      update: mocks.update,
    });
    await expect(createDeepSeekInstallation({})("update")).rejects.toThrow("original installer");
    expect(mocks.update).not.toHaveBeenCalled();
    mocks.npm.mockResolvedValue(null);
    await expect(createDeepSeekInstallation({})("check")).resolves.toMatchObject({
      canUpdate: false,
      latestVersion: "0.2.0-rc.3",
      updateAvailable: true,
    });
  });
});
