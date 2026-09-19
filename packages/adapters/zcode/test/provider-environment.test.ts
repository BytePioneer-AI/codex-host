import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { zcodeInvocation } from "../src/command.js";
import { zcodeProviderEnvironment } from "../src/provider-environment.js";
import { ZcodeTransport } from "../src/transport.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const windowsScript = "D:\\Apps\\ZCode\\resources\\glm\\zcode.cjs";
const windowsConfig = "D:\\Apps\\ZCode\\resources\\config\\provider\\zcode-builtin.json";
const builtinKey = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE";

describe("ZCode Desktop Provider configuration fallback", () => {
  it.each([
    ["win32", windowsScript],
    ["darwin", "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"],
  ] as const)("preserves existing %s native lookup locations", (platform, script) => {
    const paths = platform === "win32" ? path.win32 : path.posix;
    const directory = paths.dirname(script);
    for (const existing of [
      paths.join(directory, "provider", "zcode-builtin.json"),
      paths.resolve(directory, "../../../../../config/provider/zcode-builtin.json"),
    ]) {
      const environment = { PATH: "unchanged" };
      expect(
        zcodeProviderEnvironment(
          script,
          environment,
          platform,
          (candidate) => candidate === existing,
        ),
      ).toBe(environment);
    }
  });

  it("adds only the same-installation fallback without changing the caller's environment", () => {
    const environment = Object.freeze({ PATH: "unchanged" });
    const result = zcodeProviderEnvironment(
      windowsScript,
      environment,
      "win32",
      (candidate) => candidate === windowsConfig,
    );
    expect(result).toEqual({ ...environment, [builtinKey]: windowsConfig });
    expect(environment).not.toHaveProperty(builtinKey);
    expect(result).not.toHaveProperty("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE");
  });

  it.each([
    builtinKey,
    "zcode_builtin_provider_config_file",
    "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
    "ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE",
  ])("preserves explicit %s, even when its path is missing", (key) => {
    const environment = { [key]: "D:\\Explicit\\missing.json" };
    expect(zcodeProviderEnvironment(windowsScript, environment, "win32", () => false)).toBe(
      environment,
    );
  });

  it("reports missing bundle config rather than borrowing from another installation", () => {
    expect(() =>
      zcodeProviderEnvironment(
        windowsScript,
        {},
        "win32",
        (candidate) =>
          candidate === "C:\\Program Files\\ZCode\\resources\\config\\provider\\zcode-builtin.json",
      ),
    ).toThrow("missing its bundled provider configuration");
  });

  it("does not reinterpret custom scripts outside the Desktop layout", () => {
    const environment = {};
    expect(
      zcodeProviderEnvironment("D:\\Custom\\zcode.cjs", environment, "win32", () => false),
    ).toBe(environment);
  });

  it("attaches the fallback environment to the selected script invocation", () => {
    const invocation = zcodeInvocation({}, windowsScript, "win32", {
      isExecutable: () => false,
      isDirectory: () => false,
      isReadableFile: (candidate) => candidate === windowsScript || candidate === windowsConfig,
    });
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.arguments[0]).toBe(windowsScript);
    expect(invocation.environment[builtinKey]).toBe(windowsConfig);
  });

  it("passes the resolved environment to the actual transport child", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zcode-provider-env-"));
    roots.push(root);
    const script = path.join(root, "resources", "glm", "zcode.cjs");
    const config = path.join(root, "resources", "config", "provider", "zcode-builtin.json");
    await mkdir(path.dirname(script), { recursive: true });
    await mkdir(path.dirname(config), { recursive: true });
    await writeFile(config, "{}");
    await writeFile(
      script,
      `
      const readline = require("node:readline");
      readline.createInterface({ input: process.stdin }).on("line", line => {
        const { id } = JSON.parse(line);
        process.stdout.write(JSON.stringify({ id, result: {
          builtin: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
          personal: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ?? null,
        } }) + "\\n");
      });
    `,
    );
    const transport = new ZcodeTransport({
      cwd: root,
      command: script,
      environment: {},
      timeoutMs: 5000,
    });
    try {
      transport.start();
      expect(await transport.request("probe", {})).toEqual({ builtin: config, personal: null });
    } finally {
      await transport.close();
    }
  });
});
