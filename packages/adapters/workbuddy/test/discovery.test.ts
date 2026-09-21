import { describe, expect, it } from "vitest";
import { workBuddyInvocation } from "../src/command.js";

describe("WorkBuddy app discovery", () => {
  it.each(["WorkBuddy.exe", "WorkBuddy AI.exe", "WorkBuddyAI.exe"])(
    "finds %s inside a selected installation directory",
    (name) => {
      const directory = "D:\\自定义 WorkBuddy";
      const executable = `${directory}\\${name}`;
      const cli = `${directory}\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy`;
      const dependencies = {
        platform: "win32" as const,
        isDirectory: (candidate: string) => candidate === directory,
        isExecutable: (candidate: string) => candidate === executable || candidate === cli,
      };
      const invocation = workBuddyInvocation(
        { CODEXHOST_WORKBUDDY_COMMAND: directory },
        false,
        dependencies,
      );
      expect(invocation.command).toBe(executable);
      expect(invocation.arguments).toEqual([cli, "--acp"]);
      expect(invocation.environment.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(() =>
        workBuddyInvocation({ CODEXHOST_WORKBUDDY_COMMAND: directory }, false, {
          ...dependencies,
          isExecutable: (candidate) => candidate !== cli,
        }),
      ).toThrow("unavailable");
    },
  );
  it.each([
    [
      "win32",
      "D:\\Custom Apps\\WorkBuddy.exe",
      "D:\\Custom Apps\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy",
    ],
    [
      "win32",
      "D:\\Custom Apps\\WorkBuddyAI.exe",
      "D:\\Custom Apps\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy",
    ],
    [
      "darwin",
      "/custom/WorkBuddy AI.app/Contents/MacOS/Electron",
      "/custom/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy",
    ],
  ] as const)(
    "pairs an explicit %s Desktop path with only its own CLI",
    (platform, executable, cli) => {
      const invocation = workBuddyInvocation({ CODEXHOST_WORKBUDDY_COMMAND: executable }, false, {
        platform,
        isExecutable: (file) => file === executable || file === cli,
      });
      expect(invocation.command).toBe(executable);
      expect(invocation.arguments).toEqual([cli, "--acp"]);
      expect(invocation.environment.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(() =>
        workBuddyInvocation({ CODEXHOST_WORKBUDDY_COMMAND: executable }, false, {
          platform,
          isExecutable: (file) => file !== cli,
        }),
      ).toThrow("unavailable");
    },
  );
  it.each([
    ["C:\\Users\\Test\\AppData\\Local\\Programs\\WorkBuddy", "WorkBuddy.exe"],
    ["C:\\Users\\Test\\AppData\\Local\\Programs\\WorkBuddy AI", "WorkBuddy AI.exe"],
    ["C:\\Program Files\\WorkBuddy", "WorkBuddy.exe"],
    ["D:\\Portable WorkBuddy", "WorkBuddy.exe"],
    ["D:\\Portable WorkBuddy", "WorkBuddyAI.exe"],
  ])("finds a Windows app in %s", (root, name) => {
    const executable = `${root}\\${name}`;
    const cli = `${root}\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy`;
    const invocation = workBuddyInvocation(
      {
        USERPROFILE: "C:\\Users\\Test",
        LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
        ProgramFiles: "C:\\Program Files",
        PATH: "D:\\Portable WorkBuddy",
      },
      true,
      {
        platform: "win32",
        isExecutable: (candidate) =>
          [executable, cli].some((file) => file.toLowerCase() === candidate.toLowerCase()),
      },
    );
    expect(invocation.command.toLowerCase()).toBe(executable.toLowerCase());
    expect(invocation.arguments).toEqual([cli, "--acp", "--no-session-persistence"]);
    expect(invocation.environment).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
      WORKBUDDY_CONFIG_DIR: "C:\\Users\\Test\\.workbuddy-ai",
      CODEBUDDY_CONFIG_DIR: "C:\\Users\\Test\\.workbuddy-ai",
    });
  });

  it.each([
    "/Applications/WorkBuddy.app",
    "/Users/test/Applications/WorkBuddy AI.app",
    "/Users/test/Applications/WorkBuddy.app",
  ])("finds the macOS bundle %s", (root) => {
    const executable = `${root}/Contents/MacOS/Electron`;
    const cli = `${root}/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`;
    const invocation = workBuddyInvocation({ HOME: "/Users/test" }, false, {
      platform: "darwin",
      isExecutable: (candidate) => [executable, cli].includes(candidate),
    });
    expect(invocation.command).toBe(executable);
    expect(invocation.arguments).toEqual([cli, "--acp"]);
  });

  it("never combines an app executable with another installation's CLI", () => {
    const files = [
      "C:\\Users\\Test\\AppData\\Local\\Programs\\WorkBuddy AI\\WorkBuddy AI.exe",
      "C:\\Users\\Test\\AppData\\Local\\Programs\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy",
    ];
    expect(() =>
      workBuddyInvocation({ USERPROFILE: "C:\\Users\\Test" }, false, {
        platform: "win32",
        isExecutable: (candidate) => files.includes(candidate),
      }),
    ).toThrow("unavailable");
  });

  it("does not replace a missing explicit command with an installed app", () => {
    expect(() =>
      workBuddyInvocation(
        { USERPROFILE: "C:\\Users\\Test", CODEXHOST_WORKBUDDY_COMMAND: "C:\\missing.exe" },
        false,
        {
          platform: "win32",
          isExecutable: (candidate) => candidate !== "C:\\missing.exe",
        },
      ),
    ).toThrow("unavailable");
  });

  it("forwards the Windows product snapshot using Windows paths", () => {
    const root = "C:\\Users\\Test\\AppData\\Local\\Programs\\WorkBuddy";
    const config = "C:\\Users\\Test\\.workbuddy-ai";
    const cache = `${config}\\cache`;
    const snapshot = `${cache}\\acc-product-config-v3.json`;
    const invocation = workBuddyInvocation({ USERPROFILE: "C:\\Users\\Test" }, false, {
      platform: "win32",
      isExecutable: (candidate) =>
        [
          `${root}\\WorkBuddy.exe`,
          `${root}\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy`,
        ].includes(candidate),
      lstat: (candidate) => ({
        isDirectory: () => [config, cache].includes(candidate),
        isFile: () => candidate === snapshot,
        isSymbolicLink: () => false,
        mode: 0o666,
        size: 10,
        uid: 0,
      }),
    });
    expect(invocation.environment.ACC_PRODUCT_CONFIG_PATH).toBe(snapshot);
  });

  it("discovers a Windows app under %USERPROFILE%\\workbuddy", () => {
    const root = "C:\\Users\\Test\\workbuddy";
    const executable = `${root}\\WorkBuddy.exe`;
    const cli = `${root}\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy`;
    const invocation = workBuddyInvocation(
      {
        USERPROFILE: "C:\\Users\\Test",
        LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
        ProgramFiles: "C:\\Program Files",
      },
      false,
      {
        platform: "win32",
        isExecutable: (candidate) =>
          [executable, cli].some((file) => file.toLowerCase() === candidate.toLowerCase()),
      },
    );
    expect(invocation.command.toLowerCase()).toBe(executable.toLowerCase());
    expect(invocation.arguments).toEqual([cli, "--acp"]);
  });

  it("falls back to a running WorkBuddy process path on Windows", () => {
    const executable = "D:\\CustomInstall\\WorkBuddyAI.exe";
    const cli = "D:\\CustomInstall\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy";
    const invocation = workBuddyInvocation(
      {
        USERPROFILE: "C:\\Users\\Test",
        LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
        ProgramFiles: "C:\\Program Files",
      },
      false,
      {
        platform: "win32",
        isExecutable: (candidate) => candidate === executable || candidate === cli,
        runningExecutables: () => [executable],
      },
    );
    expect(invocation.command).toBe(executable);
    expect(invocation.arguments).toEqual([cli, "--acp"]);
    expect(invocation.environment.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("does not use a running process when CODEXHOST_WORKBUDDY_COMMAND is set but missing", () => {
    const running = "D:\\CustomInstall\\WorkBuddy.exe";
    const cli = "D:\\CustomInstall\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy";
    expect(() =>
      workBuddyInvocation(
        {
          USERPROFILE: "C:\\Users\\Test",
          CODEXHOST_WORKBUDDY_COMMAND: "C:\\missing.exe",
        },
        false,
        {
          platform: "win32",
          isExecutable: (candidate) => candidate === running || candidate === cli,
          runningExecutables: () => [running],
        },
      ),
    ).toThrow("unavailable");
  });
});
