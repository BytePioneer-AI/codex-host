import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  realpath: vi.fn(),
  resolve: vi.fn(),
  run: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<object>()),
  readFile: mocks.read,
  realpath: mocks.realpath,
}));
vi.mock("../src/resolve.js", () => ({ resolveHarnessExecutable: mocks.resolve }));
vi.mock("../src/installation.js", async (original) => ({
  ...(await original<object>()),
  runInstallationCommand: mocks.run,
  fetchInstallationText: mocks.fetch,
}));
import { npmInstallation } from "../src/npm-installation.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.realpath.mockImplementation(async (value: string) => value);
  mocks.resolve.mockReturnValue({ executable: "/other/npm" });
  mocks.fetch.mockResolvedValue(JSON.stringify({ version: "0.2.0-rc.3" }));
  mocks.run.mockResolvedValue("ok");
});
afterEach(() => vi.unstubAllGlobals());

function files(entries: Record<string, string>) {
  mocks.read.mockImplementation(async (file: string) => {
    if (file in entries) return entries[file];
    throw Object.assign(new Error("Missing fixture"), { code: "ENOENT" });
  });
}

describe("identified npm installation", () => {
  it("targets the executable's prefix even when npm comes from a different prefix", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const prefix = path.resolve("chosen-prefix");
    const directory = path.join(prefix, "lib", "node_modules", "@deepseek-ai", "dsh");
    files({
      [path.join(directory, "package.json")]: JSON.stringify({
        name: "@deepseek-ai/dsh",
        version: "0.2.0-rc.2",
      }),
    });
    const installation = await npmInstallation(
      path.join(directory, "lib", "bin.js"),
      ["@deepseek-ai/dsh"],
      {},
    );
    expect(installation?.prefix).toBe(prefix);
    expect(installation?.canUpdate).toBe(true);
    await installation?.update("0.2.0-rc.3");
    expect(mocks.run).toHaveBeenCalledWith(
      "/other/npm",
      ["install", "--global", "--prefix", prefix, "@deepseek-ai/dsh@0.2.0-rc.3"],
      expect.any(Object),
      300_000,
    );
  });

  it("recognizes Windows npm shims only when they reference the allowed package bin", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const prefix = path.resolve("windows-prefix");
    const command = path.join(prefix, "codebuddy.cmd");
    const directory = path.join(prefix, "node_modules", "@tencent-ai", "codebuddy-code");
    const metadata = JSON.stringify({
      name: "@tencent-ai/codebuddy-code",
      version: "2.1.0",
      bin: { codebuddy: "bin/codebuddy" },
    });
    files({
      [command]: '"%dp0%\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy"',
      [path.join(directory, "package.json")]: metadata,
    });
    expect(await npmInstallation(command, ["@tencent-ai/codebuddy-code"], {})).toMatchObject({
      prefix,
      canUpdate: true,
    });
    files({
      [command]: '"%dp0%\\unrelated.exe"',
      [path.join(directory, "package.json")]: metadata,
    });
    expect(await npmInstallation(command, ["@tencent-ai/codebuddy-code"], {})).toBeNull();
  });

  it("requires a prefix-level npm launcher for Windows binaries selected directly", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const prefix = path.resolve("custom-global-prefix");
    const directory = path.join(prefix, "node_modules", "@deepseek-ai", "dsh");
    const command = path.join(directory, "lib", "bin.js");
    const metadata = JSON.stringify({
      name: "@deepseek-ai/dsh",
      version: "0.2.0-rc.2",
      bin: { dsh: "lib/bin.js" },
    });
    files({ [path.join(directory, "package.json")]: metadata });
    const unknown = await npmInstallation(command, ["@deepseek-ai/dsh"], {});
    expect(unknown?.canUpdate).toBe(false);
    await expect(unknown?.latest()).resolves.toBe("0.2.0-rc.3");
    await expect(unknown?.update("0.2.0-rc.3")).rejects.toThrow("original package manager");
    expect(mocks.run).not.toHaveBeenCalled();

    files({
      [path.join(directory, "package.json")]: metadata,
      [path.join(prefix, "dsh.cmd")]: '"%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"',
    });
    const global = await npmInstallation(command, ["@deepseek-ai/dsh"], {});
    expect(global).toMatchObject({ prefix, canUpdate: true });
    await global?.update("0.2.0-rc.3");
    expect(mocks.run).toHaveBeenCalledWith(
      "/other/npm",
      ["install", "--global", "--prefix", prefix, "@deepseek-ai/dsh@0.2.0-rc.3"],
      expect.any(Object),
      300_000,
    );
  });

  it.each(["package.json", "package-lock.json", "npm-shrinkwrap.json"])(
    "keeps project-owned Windows prefixes manual even with a matching launcher: %s",
    async (marker) => {
      vi.stubGlobal("process", { ...process, platform: "win32" });
      const prefix = path.resolve("project");
      const directory = path.join(prefix, "node_modules", "opencode-ai");
      files({
        [path.join(directory, "package.json")]: JSON.stringify({
          name: "opencode-ai",
          version: "1.0.0",
          bin: { opencode: "bin/opencode.exe" },
        }),
        [path.join(prefix, "opencode.cmd")]:
          '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"',
        [path.join(prefix, marker)]: "{}",
      });
      const installation = await npmInstallation(
        path.join(directory, "bin", "opencode.exe"),
        ["opencode-ai"],
        {},
      );
      expect(installation?.canUpdate).toBe(false);
      await expect(installation?.update("1.1.0")).rejects.toThrow("original package manager");
      expect(mocks.run).not.toHaveBeenCalled();
    },
  );

  it("does not accept a Windows launcher pointing outside the selected prefix", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const prefix = path.resolve("unproven-prefix");
    const directory = path.join(prefix, "node_modules", "opencode-ai");
    files({
      [path.join(directory, "package.json")]: JSON.stringify({
        name: "opencode-ai",
        version: "1.0.0",
        bin: { opencode: "bin/opencode.exe" },
      }),
      [path.join(prefix, "opencode.cmd")]:
        '"%dp0%\\..\\other\\node_modules\\opencode-ai\\bin\\opencode.exe"',
    });
    expect(
      await npmInstallation(path.join(directory, "bin", "opencode.exe"), ["opencode-ai"], {}),
    ).toMatchObject({ canUpdate: false });
  });

  it("checks local package versions without updating the global installation", async () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    const directory = path.resolve("project", "node_modules", "@deepseek-ai", "dsh");
    files({
      [path.join(directory, "package.json")]: JSON.stringify({
        name: "@deepseek-ai/dsh",
        version: "0.2.0-rc.2",
      }),
    });
    const installation = await npmInstallation(
      path.join(directory, "lib/bin.js"),
      ["@deepseek-ai/dsh"],
      {},
    );
    expect(installation?.canUpdate).toBe(false);
    await expect(installation?.latest()).resolves.toBe("0.2.0-rc.3");
    await expect(installation?.update("0.2.0-rc.3")).rejects.toThrow("original package manager");
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
