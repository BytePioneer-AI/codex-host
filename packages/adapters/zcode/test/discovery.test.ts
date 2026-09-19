import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { zcodeInvocation } from "../src/command.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const environment = {
  USERPROFILE: "C:\\Users\\测试 User",
  LOCALAPPDATA: "C:\\Users\\测试 User\\AppData\\Local",
  ProgramFiles: "C:\\Program Files",
  Path: "D:\\Portable ZCode;C:\\CLI Tools",
};
const args = ["app-server", "--stdio", "--surface", "terminal"];
function files(executables: string[], scripts: string[] = []) {
  const contains = (entries: string[], candidate: string) =>
    entries.some((entry) => entry.toLowerCase() === candidate.toLowerCase());
  return {
    isExecutable: (candidate: string) => contains(executables, candidate),
    // Existing discovery fixtures represent complete bundles with native-adjacent config.
    isReadableFile: (candidate: string) =>
      contains(
        [
          ...scripts,
          ...scripts.map((script) =>
            path.win32.join(path.win32.dirname(script), "provider", "zcode-builtin.json"),
          ),
        ],
        candidate,
      ),
    subdirectories: () => [],
  };
}

describe("ZCode Windows discovery", () => {
  it.each(["D:\\自定义 ZCode", "D:\\自定义 ZCode\\"])(
    "resolves an installation directory %s without an exe path",
    (directory) => {
      const script = "D:\\自定义 ZCode\\resources\\glm\\zcode.cjs";
      const dependencies = {
        ...files([], [script]),
        isDirectory: (candidate: string) => candidate === directory,
      };
      expect(
        zcodeInvocation(
          { ...environment, CODEXHOST_ZCODE_COMMAND: directory },
          undefined,
          "win32",
          dependencies,
        ),
      ).toMatchObject({ command: process.execPath, arguments: [script, ...args] });
      expect(() =>
        zcodeInvocation(
          { ...environment, CODEXHOST_ZCODE_COMMAND: directory },
          undefined,
          "win32",
          {
            ...files([], ["C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs"]),
            isDirectory: dependencies.isDirectory,
          },
        ),
      ).toThrow("Install ZCode");
    },
  );
  it.each(["C:\\Users\\测试 User\\AppData\\Local\\Programs\\ZCode", "C:\\Program Files\\ZCode"])(
    "finds the bundled script in %s without a separate CLI or PATH entry",
    (root) => {
      const script = `${root}\\resources\\glm\\zcode.cjs`;
      const invocation = zcodeInvocation(environment, undefined, "win32", files([], [script]));
      expect(invocation).toEqual({
        command: process.execPath,
        arguments: [script, ...args],
        windowsVerbatimArguments: false,
        environment,
      });
    },
  );

  it("uses the script beside a portable Desktop executable on PATH", () => {
    const script = "D:\\Portable ZCode\\resources\\glm\\zcode.cjs";
    expect(
      zcodeInvocation(
        environment,
        undefined,
        "win32",
        files(["D:\\Portable ZCode\\ZCode.exe"], [script]),
      ),
    ).toMatchObject({ command: process.execPath, arguments: [script, ...args] });
  });

  it("keeps standalone CLI precedence and wraps a Windows cmd shim", () => {
    const shim = "C:\\CLI Tools\\zcode.CMD";
    const invocation = zcodeInvocation(
      environment,
      undefined,
      "win32",
      files([shim], ["C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs"]),
    );
    expect(invocation.command).toBe("cmd.exe");
    expect(invocation.windowsVerbatimArguments).toBe(true);
    expect(invocation.arguments).toEqual([
      "/d",
      "/v:off",
      "/s",
      "/c",
      `""${shim}" "app-server" "--stdio" "--surface" "terminal""`,
    ]);
  });

  it("does not combine an explicitly selected executable with another installation's script", () => {
    const executable = "D:\\Standalone\\zcode.exe";
    expect(
      zcodeInvocation(
        environment,
        executable,
        "win32",
        files([executable], ["C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs"]),
      ),
    ).toMatchObject({ command: executable, arguments: args });
  });

  it("runs an explicit readable script with the Host runtime, without cmd quoting", () => {
    const script = "D:\\自定义 ZCode\\zcode.cjs";
    expect(zcodeInvocation(environment, script, "win32", files([], [script]))).toMatchObject({
      command: process.execPath,
      arguments: [script, ...args],
      windowsVerbatimArguments: false,
    });
  });

  it.each(["CODEXHOST_ZCODE_COMMAND", "codexhost_zcode_command"])(
    "never falls back from a missing explicit %s",
    (key) => {
      expect(() =>
        zcodeInvocation(
          { ...environment, [key]: "D:\\Missing\\zcode.cjs" },
          undefined,
          "win32",
          files([], ["C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs"]),
        ),
      ).toThrow("Install ZCode");
    },
  );

  it("honors an explicit command over the environment override", () => {
    const script = "D:\\Explicit\\zcode.cjs";
    expect(
      zcodeInvocation(
        { ...environment, CODEXHOST_ZCODE_COMMAND: "D:\\Missing\\zcode.cjs" },
        script,
        "win32",
        files([], [script]),
      ).arguments,
    ).toEqual([script, ...args]);
  });

  it("rejects a real readable directory named zcode.cjs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zcode-discovery-"));
    roots.push(root);
    const directory = path.join(root, "zcode.cjs");
    await mkdir(directory);
    expect(() => zcodeInvocation({}, directory)).toThrow("Install ZCode");
  });

  it("reports not installed when no candidate is valid", () => {
    expect(() => zcodeInvocation(environment, undefined, "win32", files([]))).toThrow(
      "Install ZCode",
    );
  });
});
