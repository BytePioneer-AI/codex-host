import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as executable from "../src/executable.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("../src/executable.js", async (original) => ({
  ...(await original<typeof executable>()),
  resolveDeepSeekCommand: mocks.resolve,
}));
import { deepSeekEnvironment, deepSeekNpxVersionFile } from "../src/executable.js";
import { createDeepSeekInstallation } from "../src/installation.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockReturnValue({ command: "/chosen/dsh", arguments: [], kind: "dsh" });
  mocks.run.mockResolvedValue("0.2.0-rc.2");
  mocks.fetch.mockResolvedValue(JSON.stringify({ version: "0.2.1-rc.3" }));
});

describe("DeepSeek installation", () => {
  it("updates identified global npm installs including newer prereleases", async () => {
    mocks.npm.mockResolvedValue({
      canUpdate: true,
      latest: async () => "0.2.1-rc.3",
      update: mocks.update,
    });
    mocks.update.mockImplementation(async () => mocks.run.mockResolvedValue("0.2.1-rc.3"));
    await expect(createDeepSeekInstallation({}, "/chosen/dsh")("update")).resolves.toMatchObject({
      currentVersion: "0.2.1-rc.3",
      updateAvailable: false,
    });
    expect(mocks.npm).toHaveBeenCalledWith(
      "/chosen/dsh",
      ["@deepseek-ai/dsh"],
      expect.objectContaining({ PATH: expect.stringContaining("/chosen") }),
    );
    expect(mocks.update).toHaveBeenCalledWith("0.2.1-rc.3");
  });

  it("requires consent for the exact unverified target before updating", async () => {
    const installation = createDeepSeekInstallation({});
    mocks.fetch.mockResolvedValue(JSON.stringify({ version: "0.2.3" }));
    mocks.npm.mockResolvedValue({ canUpdate: true, update: mocks.update });
    expect(await installation("check")).toMatchObject({
      latestVersion: "0.2.3",
      latestVerifiedVersion: "0.2.2-rc.2",
    });
    await expect(installation("update")).resolves.toMatchObject({ confirmationRequired: true });
    mocks.fetch.mockResolvedValue(JSON.stringify({ version: "0.2.4" }));
    await expect(installation("update", "0.2.3")).resolves.toMatchObject({
      currentVersion: "0.2.0-rc.2",
      latestVersion: "0.2.4",
      latestVerifiedVersion: "0.2.2-rc.2",
      confirmationRequired: true,
    });
    expect(mocks.update).not.toHaveBeenCalled();
    mocks.update.mockImplementation(async () => mocks.run.mockResolvedValue("0.2.4"));
    await expect(installation("update", "0.2.4")).resolves.toMatchObject({
      currentVersion: "0.2.4",
      updateAvailable: false,
    });
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith("0.2.4");
  });

  it("queries latest independently while preserving the offline npx version probe", async () => {
    mocks.resolve.mockReturnValue({
      command: "/chosen/npx",
      arguments: ["--offline", "--no-install", "@deepseek-ai/dsh"],
      kind: "npx",
    });
    await expect(createDeepSeekInstallation({})("check")).resolves.toMatchObject({
      currentVersion: "0.2.0-rc.2",
      latestVersion: "0.2.1-rc.3",
      canUpdate: true,
      updateAvailable: true,
    });
    expect(mocks.run).toHaveBeenCalledWith(
      "/chosen/npx",
      ["--offline", "--no-install", "@deepseek-ai/dsh", "--version"],
      expect.objectContaining({ PATH: expect.stringContaining("/chosen") }),
    );
    expect(mocks.npm).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://registry.npmjs.org/%40deepseek-ai%2Fdsh/latest",
    );
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  describe("npx updates", () => {
    let environment: NodeJS.ProcessEnv;
    let directory: string;
    let npx: string;
    let resolve: (typeof executable)["resolveDeepSeekCommand"];

    beforeEach(async () => {
      directory = await mkdtemp(path.join(tmpdir(), "codexhost-dsh-npx-"));
      environment = { HOME: directory, PATH: directory, CODEXHOST_DATA_DIR: directory };
      npx = path.join(directory, process.platform === "win32" ? "npx.cmd" : "npx");
      await writeFile(npx, "", { mode: 0o700 });
      ({ resolveDeepSeekCommand: resolve } =
        await vi.importActual<typeof executable>("../src/executable.js"));
      mocks.resolve.mockImplementation(resolve);
    });

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it("updates and selects only the exact version after verifying the offline launch", async () => {
      mocks.run.mockResolvedValueOnce("0.2.0-rc.2").mockResolvedValue("0.2.1-rc.3");
      await expect(createDeepSeekInstallation(environment)("update")).resolves.toMatchObject({
        currentVersion: "0.2.1-rc.3",
        canUpdate: true,
        updateAvailable: false,
      });
      const expectedEnvironment = deepSeekEnvironment(npx, environment);
      expect(mocks.run).toHaveBeenNthCalledWith(
        2,
        npx,
        ["--yes", "--prefer-online", "@deepseek-ai/dsh@0.2.1-rc.3", "--version"],
        expectedEnvironment,
        600_000,
      );
      expect(mocks.run).toHaveBeenNthCalledWith(
        3,
        npx,
        ["--offline", "--no-install", "@deepseek-ai/dsh@0.2.1-rc.3", "--version"],
        expectedEnvironment,
      );
      expect(resolve(undefined, environment)?.arguments).toEqual([
        "--offline",
        "--no-install",
        "@deepseek-ai/dsh@0.2.1-rc.3",
      ]);
      expect(mocks.npm).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    });

    it("does not download when the current version is already latest", async () => {
      mocks.fetch.mockResolvedValue(JSON.stringify({ version: "0.2.0-rc.2" }));
      await expect(createDeepSeekInstallation(environment)("update")).resolves.toMatchObject({
        updateAvailable: false,
      });
      expect(mocks.run).toHaveBeenCalledOnce();
    });

    it("rejects a download that still selects the old version", async () => {
      await expect(createDeepSeekInstallation(environment)("update")).rejects.toThrow(
        "requested version",
      );
      expect(mocks.run).toHaveBeenCalledTimes(2);
    });

    it("keeps the previous pin when the targeted offline cache is unavailable", async () => {
      const pin = deepSeekNpxVersionFile(environment);
      await writeFile(pin, "0.2.0-rc.2\n");
      mocks.run
        .mockResolvedValueOnce("0.2.0-rc.2")
        .mockResolvedValueOnce("0.2.1-rc.3")
        .mockResolvedValueOnce("0.2.0-rc.2");
      await expect(createDeepSeekInstallation(environment)("update")).rejects.toThrow(
        "offline npx launch",
      );
      expect(await readFile(pin, "utf8")).toBe("0.2.0-rc.2\n");
    });

    it("shares concurrent updates and allows retry after download failure", async () => {
      mocks.run
        .mockResolvedValueOnce("0.2.0-rc.2")
        .mockRejectedValueOnce(new Error("download failed"));
      const installation = createDeepSeekInstallation(environment);
      const first = installation("update");
      expect(installation("update")).toBe(first);
      await expect(first).rejects.toThrow("download failed");
      mocks.run.mockResolvedValueOnce("0.2.0-rc.2").mockResolvedValue("0.2.1-rc.3");
      await expect(installation("update")).resolves.toMatchObject({ currentVersion: "0.2.1-rc.3" });
    });

    it.each(["{}", '{"version":"not-a-version"}', "not-json"])(
      "rejects invalid registry metadata: %s",
      async (metadata) => {
        mocks.fetch.mockResolvedValue(metadata);
        await expect(createDeepSeekInstallation(environment)("update")).rejects.toThrow();
        expect(mocks.run).toHaveBeenCalledOnce();
      },
    );

    it("does not attempt an update when the registry request fails", async () => {
      mocks.fetch.mockRejectedValue(new Error("network unavailable"));
      await expect(createDeepSeekInstallation(environment)("update")).rejects.toThrow(
        "network unavailable",
      );
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
      latestVersion: "0.2.1-rc.3",
      updateAvailable: true,
    });
  });
});
