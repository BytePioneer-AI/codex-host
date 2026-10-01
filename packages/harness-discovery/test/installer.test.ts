import { readFile, access } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarnessInstaller } from "../src/installer.js";
import { fetchInstallationText, runInstallationCommand } from "../src/installation.js";
import { resolveHarnessExecutable } from "../src/resolve.js";
import type * as ResolverModule from "../src/resolve.js";

vi.mock("../src/installation.js", () => ({
  fetchInstallationText: vi.fn(async () => "# official installer"),
  runInstallationCommand: vi.fn(async () => ""),
}));
vi.mock("../src/resolve.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ResolverModule>()),
  resolveHarnessExecutable: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());
describe("Adapter-owned CLI installers", () => {
  it.each([
    ["linux", "/home/test/.nvm/versions/node/v22.0.0/bin/npm", "/home/test/.nvm/versions/node"],
    [
      "linux",
      "/home/test/.local/share/fnm/node-versions/v22.0.0/installation/bin/npm",
      "/home/test/.local/share/fnm/node-versions",
    ],
    [
      "linux",
      "/home/test/.asdf/installs/nodejs/v22.0.0/bin/npm",
      "/home/test/.asdf/installs/nodejs",
    ],
    ["darwin", "/opt/homebrew/bin/npm", ""],
    ["linux", "/usr/local/bin/npm", ""],
    ["win32", "C:\\Program Files\\nodejs\\npm.cmd", ""],
    ["win32", "C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd", ""],
    [
      "win32",
      "C:\\Users\\test\\AppData\\Roaming\\nvm\\v22.0.0\\npm.cmd",
      "C:\\Users\\test\\AppData\\Roaming\\nvm",
    ],
  ] as const)(
    "finds npm with a minimal GUI PATH on %s: %s",
    async (platform, executable, versionRoot) => {
      const actual = await vi.importActual<typeof ResolverModule>("../src/resolve.js");
      vi.mocked(resolveHarnessExecutable).mockImplementationOnce((spec) =>
        actual.resolveHarnessExecutable(
          spec,
          {
            platform,
            homeDirectory: platform === "win32" ? "C:\\Users\\test" : "/home/test",
            environment: { PATH: "", ProgramFiles: "C:\\Program Files" },
          },
          {
            isExecutable: (candidate) => candidate === executable,
            subdirectories: (directory) => (directory === versionRoot ? ["v22.0.0"] : []),
          },
        ),
      );
      await createHarnessInstaller({}, { npm: "opencode-ai" })();
      expect(runInstallationCommand).toHaveBeenCalledWith(
        executable,
        ["install", "--global", "opencode-ai"],
        expect.any(Object),
        600_000,
      );
    },
  );
  it("requires npm and preserves a pinned package version", async () => {
    vi.mocked(resolveHarnessExecutable).mockReturnValue(undefined);
    const install = createHarnessInstaller({}, { npm: "@deepseek-ai/dsh@0.1.5-rc.1" });
    await expect(install()).rejects.toThrow("Node.js and npm");
    expect(runInstallationCommand).not.toHaveBeenCalled();
    vi.mocked(resolveHarnessExecutable).mockReturnValue({ executable: "/bin/npm" } as never);
    await install();
    expect(runInstallationCommand).toHaveBeenCalledWith(
      "/bin/npm",
      ["install", "--global", "@deepseek-ai/dsh@0.1.5-rc.1"],
      expect.any(Object),
      600_000,
    );
  });
  it("allows the Grok package's required postinstall", async () => {
    vi.mocked(resolveHarnessExecutable).mockReturnValue({ executable: "/bin/npm" } as never);
    await createHarnessInstaller(
      {},
      { npm: "@xai-official/grok", allowScripts: "@xai-official/grok" },
    )();
    expect(runInstallationCommand).toHaveBeenCalledWith(
      "/bin/npm",
      expect.any(Array),
      expect.objectContaining({ npm_config_allow_scripts: "@xai-official/grok" }),
      600_000,
    );
  });
  it("downloads an HTTPS script to a temporary file and cleans it up on failure", async () => {
    let file = "";
    vi.mocked(runInstallationCommand).mockImplementationOnce(async (_command, args) => {
      file = args.at(-1) ?? "";
      expect(await readFile(file, "utf8")).toBe("# official installer");
      throw new Error("installer failed");
    });
    await expect(
      createHarnessInstaller(
        {},
        {
          posix: "https://example.com/install.sh",
          windows: "https://example.com/install.ps1",
          shell: "sh",
        },
      )(),
    ).rejects.toThrow("installer failed");
    expect(fetchInstallationText).toHaveBeenCalledWith(expect.stringMatching(/^https:/));
    await expect(access(file)).rejects.toThrow();
  });
  it("does not fetch insecure script sources", async () => {
    await expect(
      createHarnessInstaller({}, { posix: "http://example.com", windows: "http://example.com" })(),
    ).rejects.toThrow("HTTPS");
    expect(fetchInstallationText).not.toHaveBeenCalled();
  });
});
