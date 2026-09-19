import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORKBUDDY_DISABLE_PRODUCT_CACHE_ENV,
  WORKBUDDY_MACOS_CLI,
  WORKBUDDY_MACOS_ELECTRON,
  workBuddyEnvironment,
  workBuddyInvocation,
} from "../src/command.js";

const isBundledExecutable = (candidate: string) =>
  [WORKBUDDY_MACOS_ELECTRON, WORKBUDDY_MACOS_CLI].includes(candidate);

function productConfigMetadata(
  overrides: Partial<{
    directory: boolean;
    file: boolean;
    symbolicLink: boolean;
    mode: number;
    size: number;
    uid: number;
  }> = {},
) {
  const values = {
    directory: false,
    file: true,
    symbolicLink: false,
    mode: 0o100600,
    size: 1,
    uid: 501,
    ...overrides,
  };
  return {
    isDirectory: () => values.directory,
    isFile: () => values.file,
    isSymbolicLink: () => values.symbolicLink,
    mode: values.mode,
    size: values.size,
    uid: values.uid,
  };
}

const productConfigDirectoryMetadata = () =>
  productConfigMetadata({ directory: true, file: false, mode: 0o40700 });

describe("WorkBuddy command invocation", () => {
  it("uses only the macOS app-owned Electron and CLI by default", () => {
    const seen: string[] = [];
    const invocation = workBuddyInvocation({ HOME: "/Users/test", PATH: "/ordinary/bin" }, true, {
      platform: "darwin",
      isExecutable: (candidate) => {
        seen.push(candidate);
        return [WORKBUDDY_MACOS_ELECTRON, WORKBUDDY_MACOS_CLI].includes(candidate);
      },
    });

    expect(invocation.command).toBe(WORKBUDDY_MACOS_ELECTRON);
    expect(invocation.arguments).toEqual([
      WORKBUDDY_MACOS_CLI,
      "--acp",
      "--no-session-persistence",
    ]);
    expect(invocation.environment).toMatchObject({
      CODEBUDDY_CONFIG_DIR: "/Users/test/.workbuddy-ai",
      WORKBUDDY_CONFIG_DIR: "/Users/test/.workbuddy-ai",
      ELECTRON_RUN_AS_NODE: "1",
      DISABLE_AUTOUPDATER: "1",
    });
    expect(invocation.environment).not.toHaveProperty("CODEBUDDY_HOST");
    expect(invocation.environment).not.toHaveProperty("WORKBUDDY_DATA_FOLDER_NAME");
    expect(seen).toEqual([WORKBUDDY_MACOS_ELECTRON, WORKBUDDY_MACOS_CLI]);
  });

  it("forwards WorkBuddy's private product snapshot to the bundled ACP CLI", () => {
    const productConfigPath = "/Users/test/.workbuddy-ai/cache/acc-product-config-v3.json";
    const invocation = workBuddyInvocation({ HOME: "/Users/test", PATH: "/ordinary/bin" }, true, {
      platform: "darwin",
      isExecutable: isBundledExecutable,
      lstat: (candidate: string) => {
        if (candidate === productConfigPath) return productConfigMetadata();
        expect(candidate).toMatch(/^\/Users\/test\/\.workbuddy-ai(?:\/cache)?$/);
        return productConfigDirectoryMetadata();
      },
      getuid: () => 501,
    });

    expect(invocation.environment.ACC_PRODUCT_CONFIG_PATH).toBe(productConfigPath);
  });

  it("suppresses disk snapshot inference for the Windows live-product path", () => {
    let inspected = false;
    const invocation = workBuddyInvocation(
      {
        HOME: "/Users/test",
        [WORKBUDDY_DISABLE_PRODUCT_CACHE_ENV]: "1",
      },
      true,
      {
        platform: "darwin",
        isExecutable: isBundledExecutable,
        lstat: () => {
          inspected = true;
          return productConfigMetadata();
        },
      },
    );

    expect(inspected).toBe(false);
    expect(invocation.environment).not.toHaveProperty("ACC_PRODUCT_CONFIG_PATH");
    expect(invocation.environment).not.toHaveProperty(WORKBUDDY_DISABLE_PRODUCT_CACHE_ENV);
  });

  it("resolves the product snapshot from an explicit WorkBuddy root", () => {
    const root = "/private/workbuddy";
    const productConfigPath = `${root}/cache/acc-product-config-v3.json`;
    const invocation = workBuddyInvocation(
      { HOME: "/Users/test", WORKBUDDY_CONFIG_DIR: root },
      true,
      {
        platform: "darwin",
        isExecutable: isBundledExecutable,
        lstat: (candidate) =>
          candidate === productConfigPath
            ? productConfigMetadata()
            : productConfigDirectoryMetadata(),
        getuid: () => 501,
      },
    );

    expect(invocation.environment.ACC_PRODUCT_CONFIG_PATH).toBe(productConfigPath);
  });

  it.each([
    ["ACC_PRODUCT_CONFIG_PATH", "/explicit/product.json"],
    ["ACC_PRODUCT_CONFIG_V3", '{"models":[]}'],
    ["ACC_PRODUCT_CONFIG_V2", '{"models":[]}'],
    ["ACC_PRODUCT_CONFIG", '{"models":[]}'],
  ])("preserves an explicit %s override", (name, value) => {
    let inspected = false;
    const invocation = workBuddyInvocation({ HOME: "/Users/test", [name]: value }, true, {
      platform: "darwin",
      isExecutable: isBundledExecutable,
      lstat: () => {
        inspected = true;
        return productConfigMetadata();
      },
      getuid: () => 501,
    });

    expect(invocation.environment[name]).toBe(value);
    expect(inspected).toBe(false);
  });

  it("preserves explicitly combined path and inline product snapshots", () => {
    const invocation = workBuddyInvocation(
      {
        HOME: "/Users/test",
        ACC_PRODUCT_CONFIG_PATH: "/explicit/product.json",
        ACC_PRODUCT_CONFIG_V3: '{"models":["v3"]}',
        ACC_PRODUCT_CONFIG_V2: '{"models":["v2"]}',
        ACC_PRODUCT_CONFIG: '{"models":["legacy"]}',
      },
      true,
      { platform: "darwin", isExecutable: isBundledExecutable },
    );

    expect(invocation.environment.ACC_PRODUCT_CONFIG_PATH).toBe("/explicit/product.json");
    expect(invocation.environment.ACC_PRODUCT_CONFIG_V3).toBe('{"models":["v3"]}');
    expect(invocation.environment.ACC_PRODUCT_CONFIG_V2).toBe('{"models":["v2"]}');
    expect(invocation.environment.ACC_PRODUCT_CONFIG).toBe('{"models":["legacy"]}');
  });

  it.each([
    ["a directory", productConfigMetadata({ file: false })],
    ["a symlink", productConfigMetadata({ symbolicLink: true })],
    ["an empty file", productConfigMetadata({ size: 0 })],
    ["a broadly readable file", productConfigMetadata({ mode: 0o100644 })],
    ["a file owned by another user", productConfigMetadata({ uid: 502 })],
  ])("does not forward %s as the product snapshot", (_description, metadata) => {
    const productConfigPath = "/Users/test/.workbuddy-ai/cache/acc-product-config-v3.json";
    const invocation = workBuddyInvocation({ HOME: "/Users/test" }, true, {
      platform: "darwin",
      isExecutable: isBundledExecutable,
      lstat: (candidate) =>
        candidate === productConfigPath ? metadata : productConfigDirectoryMetadata(),
      getuid: () => 501,
    });

    expect(invocation.environment).not.toHaveProperty("ACC_PRODUCT_CONFIG_PATH");
  });

  it.each([
    ["a symlinked root", "/Users/test/.workbuddy-ai", { symbolicLink: true }],
    ["a group-writable cache", "/Users/test/.workbuddy-ai/cache", { mode: 0o40720 }],
    ["a cache owned by another user", "/Users/test/.workbuddy-ai/cache", { uid: 502 }],
  ])("does not traverse %s", (_description, rejectedPath, overrides) => {
    const productConfigPath = "/Users/test/.workbuddy-ai/cache/acc-product-config-v3.json";
    const invocation = workBuddyInvocation({ HOME: "/Users/test" }, true, {
      platform: "darwin",
      isExecutable: isBundledExecutable,
      lstat: (candidate) => {
        if (candidate === rejectedPath)
          return productConfigMetadata({
            directory: true,
            file: false,
            mode: 0o40700,
            ...overrides,
          });
        if (candidate === productConfigPath) return productConfigMetadata();
        return productConfigDirectoryMetadata();
      },
      getuid: () => 501,
    });

    expect(invocation.environment).not.toHaveProperty("ACC_PRODUCT_CONFIG_PATH");
  });

  it("keeps a missing product snapshot as the bundled CLI fallback", () => {
    const productConfigPath = "/Users/test/.workbuddy-ai/cache/acc-product-config-v3.json";
    const invocation = workBuddyInvocation({ HOME: "/Users/test" }, true, {
      platform: "darwin",
      isExecutable: isBundledExecutable,
      lstat: (candidate) => {
        if (candidate === productConfigPath) throw new Error("ENOENT");
        return productConfigDirectoryMetadata();
      },
      getuid: () => 501,
    });

    expect(invocation.environment).not.toHaveProperty("ACC_PRODUCT_CONFIG_PATH");
  });

  it("honors the explicit WorkBuddy command without adding the bundled script", () => {
    const invocation = workBuddyInvocation(
      {
        HOME: "/Users/test",
        CODEXHOST_WORKBUDDY_COMMAND: "/custom/workbuddy-cli",
        CODEBUDDY_CONFIG_DIR: "/custom/codebuddy-root",
        WORKBUDDY_CONFIG_DIR: "/custom/workbuddy-root",
      },
      false,
      { platform: "darwin", isExecutable: (candidate) => candidate === "/custom/workbuddy-cli" },
    );

    expect(invocation.command).toBe("/custom/workbuddy-cli");
    expect(invocation.arguments).toEqual(["--acp"]);
    expect(invocation.environment).toMatchObject({
      CODEBUDDY_CONFIG_DIR: "/custom/workbuddy-root",
      WORKBUDDY_CONFIG_DIR: "/custom/workbuddy-root",
    });
    expect(invocation.environment).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
  });

  it("does not infer a private product snapshot for an explicit command", () => {
    let inspected = false;
    const invocation = workBuddyInvocation(
      {
        HOME: "/Users/test",
        CODEXHOST_WORKBUDDY_COMMAND: "/custom/workbuddy-cli",
      },
      false,
      {
        platform: "darwin",
        isExecutable: (candidate) => candidate === "/custom/workbuddy-cli",
        lstat: () => {
          inspected = true;
          return productConfigMetadata();
        },
        getuid: () => 501,
      },
    );

    expect(invocation.environment).not.toHaveProperty("ACC_PRODUCT_CONFIG_PATH");
    expect(inspected).toBe(false);
  });

  it("keeps the WorkBuddy executable while replacing ACP arguments for native administration", () => {
    const invocation = workBuddyInvocation(
      { HOME: "/Users/test" },
      false,
      {
        platform: "darwin",
        isExecutable: (candidate) =>
          [WORKBUDDY_MACOS_ELECTRON, WORKBUDDY_MACOS_CLI].includes(candidate),
      },
      ["--resume", "source", "--fork-session", "--session-id", "target"],
    );

    expect(invocation.command).toBe(WORKBUDDY_MACOS_ELECTRON);
    expect(invocation.arguments).toEqual([
      WORKBUDDY_MACOS_CLI,
      "--resume",
      "source",
      "--fork-session",
      "--session-id",
      "target",
    ]);
  });

  it("does not fall back to a PATH CodeBuddy on unsupported platforms", () => {
    expect(() =>
      workBuddyInvocation({ HOME: "/home/test", PATH: "/ordinary/codebuddy/bin" }, false, {
        platform: "linux",
        isExecutable: () => true,
      }),
    ).toThrow("CODEXHOST_WORKBUDDY_COMMAND");
  });

  it("uses WorkBuddy's root when only WORKBUDDY_CONFIG_DIR is configured", () => {
    expect(
      workBuddyEnvironment({ HOME: "/Users/test", WORKBUDDY_CONFIG_DIR: "/workbuddy" }, "darwin"),
    ).toMatchObject({
      CODEBUDDY_CONFIG_DIR: "/workbuddy",
      WORKBUDDY_CONFIG_DIR: "/workbuddy",
    });
    expect(workBuddyEnvironment({ HOME: "/Users/test" }, "darwin").CODEBUDDY_CONFIG_DIR).toBe(
      "/Users/test/.workbuddy-ai",
    );
  });

  it("uses Windows paths for configured and default WorkBuddy roots", () => {
    expect(
      workBuddyEnvironment({ WORKBUDDY_CONFIG_DIR: "C:/WorkBuddy/config" }, "win32"),
    ).toMatchObject({
      CODEBUDDY_CONFIG_DIR: "C:\\WorkBuddy\\config",
      WORKBUDDY_CONFIG_DIR: "C:\\WorkBuddy\\config",
    });
    expect(workBuddyEnvironment({ USERPROFILE: "C:\\Users\\test" }, "win32")).toMatchObject({
      CODEBUDDY_CONFIG_DIR: "C:\\Users\\test\\.workbuddy-ai",
      WORKBUDDY_CONFIG_DIR: "C:\\Users\\test\\.workbuddy-ai",
    });
  });

  it("makes a relative WorkBuddy root stable across Host and ACP working directories", () => {
    const root = path.posix.resolve("relative-workbuddy-root");
    const productConfigPath = path.posix.join(root, "cache", "acc-product-config-v3.json");
    const invocation = workBuddyInvocation(
      { HOME: "/Users/test", WORKBUDDY_CONFIG_DIR: "relative-workbuddy-root" },
      true,
      {
        platform: "darwin",
        isExecutable: isBundledExecutable,
        lstat: (candidate) =>
          candidate === productConfigPath
            ? productConfigMetadata()
            : productConfigDirectoryMetadata(),
        getuid: () => 501,
      },
    );

    expect(invocation.environment.WORKBUDDY_CONFIG_DIR).toBe(root);
    expect(invocation.environment.CODEBUDDY_CONFIG_DIR).toBe(root);
    expect(invocation.environment.ACC_PRODUCT_CONFIG_PATH).toBe(productConfigPath);
  });

  it("does not inherit a global CodeBuddy history root or overwrite updater policy", () => {
    expect(
      workBuddyEnvironment(
        {
          HOME: "/Users/test",
          CODEBUDDY_CONFIG_DIR: "/ordinary-codebuddy",
          DISABLE_AUTOUPDATER: "0",
        },
        "darwin",
      ),
    ).toMatchObject({
      CODEBUDDY_CONFIG_DIR: "/Users/test/.workbuddy-ai",
      WORKBUDDY_CONFIG_DIR: "/Users/test/.workbuddy-ai",
      DISABLE_AUTOUPDATER: "0",
    });
  });

  it.each(["", "   "])("treats an empty WorkBuddy root %j as unset", (configuredRoot) => {
    expect(
      workBuddyEnvironment({ HOME: "/Users/test", WORKBUDDY_CONFIG_DIR: configuredRoot }, "darwin"),
    ).toMatchObject({
      CODEBUDDY_CONFIG_DIR: "/Users/test/.workbuddy-ai",
      WORKBUDDY_CONFIG_DIR: "/Users/test/.workbuddy-ai",
    });
  });
});

describe("WorkBuddy model-free history copy startup", () => {
  const copyArguments = [
    "--resume",
    "source",
    "--fork-session",
    "--session-id",
    "target",
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
  ];
  const dependencies = { platform: "darwin" as const, isExecutable: isBundledExecutable };

  it("skips telemetry initialization only for the bundled print-copy process", () => {
    const environment = { HOME: "/Users/test" };
    const copy = workBuddyInvocation(environment, false, dependencies, copyArguments);
    expect(copy.environment.DISABLE_TELEMETRY).toBe("1");
    expect(copy.arguments).toEqual([WORKBUDDY_MACOS_CLI, ...copyArguments]);
    expect(environment).not.toHaveProperty("DISABLE_TELEMETRY");
    for (const args of [undefined, ["--acp", "--serve"], ["--print"], ["--fork-session"]]) {
      expect(
        workBuddyInvocation(environment, false, dependencies, args).environment,
      ).not.toHaveProperty("DISABLE_TELEMETRY");
    }
  });

  it.each(["", "0", "1"])("preserves explicit telemetry setting %j", (value) => {
    expect(
      workBuddyInvocation(
        { HOME: "/Users/test", DISABLE_TELEMETRY: value },
        false,
        dependencies,
        copyArguments,
      ).environment.DISABLE_TELEMETRY,
    ).toBe(value);
  });

  it("does not assume that a custom runtime supports the bundled telemetry switch", () => {
    const copy = workBuddyInvocation(
      { HOME: "/Users/test", CODEXHOST_WORKBUDDY_COMMAND: "/custom/workbuddy" },
      false,
      { platform: "darwin", isExecutable: (candidate) => candidate === "/custom/workbuddy" },
      copyArguments,
    );
    expect(copy.environment).not.toHaveProperty("DISABLE_TELEMETRY");
  });
});
