import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), run: vi.fn() }));
vi.mock("../src/command.js", async (original) => ({
  ...(await original<object>()),
  resolveWorkBuddyLaunch: mocks.resolve,
}));
vi.mock("@codexhost/harness-discovery", async (original) => ({
  ...(await original<object>()),
  runInstallationCommand: mocks.run,
}));
import { createWorkBuddyInstallation } from "../src/installation.js";
import { createHarnessAdapter } from "../src/plugin.js";

const product = {
  applicationName: "workbuddy-ai",
  genieVersion: "5.5.2",
  updateUrl: "https://www.workbuddy.ai",
};
const cli = "/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy";
const installerRoot = "https://download.codebuddy.ai/workbuddy/saas";
const feed = (target = "darwin-arm64", version = "5.8.4.41366630", host = installerRoot) =>
  JSON.stringify({
    version,
    url: `${host}/${target}/WorkBuddy-${target}-${version}-73952edb.${target.startsWith("darwin") ? "zip" : "exe"}`,
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockReturnValue({ executable: "/app/Electron", bundle: { cli } });
});

describe("WorkBuddy desktop application updates", () => {
  it.each([
    ["darwin", "arm64", "darwin-arm64", "dmg"],
    ["darwin", "x64", "darwin-x64", "dmg"],
    ["win32", "x64", "win32-x64-user", "exe"],
  ] as const)(
    "offers the official %s %s installer without running the CLI",
    async (platform, arch, target, extension) => {
      const readProduct = vi.fn(async () => product);
      const fetchText = vi.fn(async () => feed(target));
      const environment = { CODEXHOST_WORKBUDDY_COMMAND: "/selected/install" };
      const installation = createWorkBuddyInstallation(environment, {
        platform,
        arch,
        readProduct,
        fetchText,
      });
      await expect(installation("check")).resolves.toMatchObject({
        currentVersion: "5.5.2",
        latestVersion: "5.8.4",
        updateAvailable: true,
        canUpdate: false,
        manualUpdateUrl: `${installerRoot}/${target}/WorkBuddy-${target}-5.8.4.41366630-73952edb.${extension}`,
      });
      expect(mocks.resolve).toHaveBeenCalledWith(environment, { platform });
      expect(fetchText).toHaveBeenCalledWith(
        `https://www.workbuddy.ai/v2/update?platform=workbuddy-${target}`,
      );
      expect(mocks.run).not.toHaveBeenCalled();
    },
  );

  it("reads metadata beside the selected bundled CLI", async () => {
    const readProduct = vi.fn(async () => product);
    await createWorkBuddyInstallation(
      {},
      { platform: "darwin", arch: "arm64", readProduct, fetchText: async () => feed() },
    )("check");
    expect(readProduct).toHaveBeenCalledWith(
      "/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/product.json",
    );
  });

  it("reads Windows metadata from the selected app rather than the default installation", async () => {
    mocks.resolve.mockReturnValue({
      executable: "D:\\Apps\\WorkBuddy\\WorkBuddyAI.exe",
      bundle: { cli: "D:\\Apps\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy" },
    });
    const readProduct = vi.fn(async () => product);
    await createWorkBuddyInstallation(
      {},
      {
        platform: "win32",
        arch: "x64",
        readProduct,
        fetchText: async () => feed("win32-x64-user"),
      },
    )("check");
    expect(readProduct).toHaveBeenCalledWith(
      "D:\\Apps\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\product.json",
    );
  });

  it("keeps the China edition on its own public channel", async () => {
    const fetchText = vi.fn(async () =>
      feed("darwin-arm64", "5.8.3.123", "https://download.codebuddy.cn/workbuddy/saas"),
    );
    const result = await createWorkBuddyInstallation(
      {},
      {
        platform: "darwin",
        arch: "arm64",
        readProduct: async () => ({
          ...product,
          applicationName: "workbuddy",
          updateUrl: "https://www.workbuddy.cn",
        }),
        fetchText,
      },
    )("check");
    expect(fetchText).toHaveBeenCalledWith(
      "https://www.workbuddy.cn/v2/update?platform=workbuddy-darwin-arm64",
    );
    expect(result.manualUpdateUrl).toContain("https://download.codebuddy.cn/");
  });

  it.each(["5.5.2.999", "5.4.0.999"])(
    "does not offer a downgrade or an unidentifiable build-only change: %s",
    async (version) => {
      const result = await createWorkBuddyInstallation(
        {},
        {
          platform: "darwin",
          arch: "arm64",
          readProduct: async () => product,
          fetchText: async () => feed("darwin-arm64", version),
        },
      )("check");
      expect(result.updateAvailable).toBe(false);
      expect(result.manualUpdateUrl).toBeUndefined();
    },
  );

  it.each([
    "offline",
    "invalid-json",
    "wrong-host",
    "credentials",
    "wrong-platform",
    "wrong-product",
    "invalid-version",
  ])(
    "preserves the installed version without an unsafe download when the feed is %s",
    async (failure) => {
      const fetchText = async () => {
        if (failure === "offline") throw new Error("offline");
        if (failure === "invalid-json") return "<html>bad gateway</html>";
        const value = JSON.parse(feed());
        if (failure === "wrong-host")
          value.url = value.url.replace("download.codebuddy.ai", "example.invalid");
        if (failure === "credentials")
          value.url = value.url.replace("https://", "https://user:password@");
        if (failure === "wrong-platform")
          value.url = value.url.replaceAll("darwin-arm64", "darwin-x64");
        if (failure === "wrong-product") value.url = value.url.replace("/workbuddy/", "/other/");
        if (failure === "invalid-version") value.version = "Unknown";
        return JSON.stringify(value);
      };
      await expect(
        createWorkBuddyInstallation(
          {},
          { platform: "darwin", arch: "arm64", readProduct: async () => product, fetchText },
        )("check"),
      ).resolves.toMatchObject({
        currentVersion: "5.5.2",
        latestVersion: "Unknown",
        canUpdate: false,
        updateAvailable: false,
      });
      expect(mocks.run).not.toHaveBeenCalled();
    },
  );

  it("does not send enterprise installations to the public SaaS feed", async () => {
    const fetchText = vi.fn();
    const result = await createWorkBuddyInstallation(
      {},
      {
        platform: "darwin",
        arch: "arm64",
        readProduct: async () => ({ ...product, updateUrl: "https://enterprise.example" }),
        fetchText,
      },
    )("check");
    expect(fetchText).not.toHaveBeenCalled();
    expect(result.latestVersion).toBe("Unknown");
    expect(result.manualUpdateUrl).toBeUndefined();
  });

  it("preserves an explicit private update server instead of querying the public channel", async () => {
    const fetchText = vi.fn();
    const result = await createWorkBuddyInstallation(
      { WORKBUDDY_UPDATE_URL: "https://enterprise.example" },
      { platform: "darwin", arch: "arm64", readProduct: async () => product, fetchText },
    )("check");
    expect(fetchText).not.toHaveBeenCalled();
    expect(result.manualUpdateUrl).toBeUndefined();
    expect(result.currentVersion).toBe("5.5.2");
  });

  it("does not assign desktop releases to a custom standalone CLI", async () => {
    mocks.resolve.mockReturnValue({ executable: "/chosen/cli" });
    mocks.run.mockResolvedValue("2.137.1");
    const fetchText = vi.fn();
    const result = await createWorkBuddyInstallation({}, { fetchText })("check");
    expect(result).toMatchObject({
      currentVersion: "2.137.1",
      latestVersion: "Unknown",
      canUpdate: false,
    });
    expect(fetchText).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledWith("/chosen/cli", ["--version"], {});
  });

  it("rejects automatic updates before resolving or running any process", async () => {
    await expect(createWorkBuddyInstallation({})("update")).rejects.toThrow(
      "official desktop installer",
    );
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("wires version management through the plugin factory with the saved path taking precedence", async () => {
    const adapter = createHarnessAdapter({
      environment: { CODEXHOST_WORKBUDDY_COMMAND: "/environment/install" },
      launchCommand: "/saved/install",
      platform: process.platform,
      managedRemoteHost: false,
    });
    mocks.resolve.mockImplementation(() => {
      throw new Error("selected installation");
    });
    try {
      expect("installation" in adapter).toBe(true);
      if (!("installation" in adapter)) throw new Error("Missing installation capability");
      await expect(adapter.installation("check")).rejects.toThrow("selected installation");
      expect(mocks.resolve).toHaveBeenCalledWith(
        { CODEXHOST_WORKBUDDY_COMMAND: "/saved/install" },
        { platform: process.platform },
      );
    } finally {
      await adapter.close();
    }
  });
});
