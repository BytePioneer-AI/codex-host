import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_COMMAND_ENV,
  ANTIGRAVITY_DISABLE_AUTO_UPDATE_ENV,
  antigravityProcessEnvironment,
  createHarnessAdapter,
} from "../src/plugin.js";

/** The test process environment without any spelling of the self-updater switch. */
function environmentWithoutSwitch(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name.toUpperCase() !== ANTIGRAVITY_DISABLE_AUTO_UPDATE_ENV,
    ),
  );
}

/** A stand-in agy that records the switch it was started with and lists one Model. */
async function recordingAgy(): Promise<{
  command: string;
  cwd: string;
  recorded(): Promise<string>;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-plugin-"));
  // Kept outside the shim directory: Windows holds a handle on a directory it executed from.
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-plugin-cwd-"));
  const record = path.join(directory, "switch.txt");
  const script = `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(record)}, process.env.${ANTIGRAVITY_DISABLE_AUTO_UPDATE_ENV} ?? "<unset>");
if (process.argv.includes("models")) {
  process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash High\\n");
}
`;
  const jsPath = path.join(directory, "agy.cjs");
  await writeFile(jsPath, script);
  let command: string;
  if (process.platform === "win32") {
    command = path.join(directory, "agy.cmd");
    await writeFile(command, `@node "${jsPath}" %*\r\n`);
  } else {
    command = path.join(directory, "agy");
    await writeFile(command, `#!/usr/bin/env node\n${script}`);
    await chmod(command, 0o755);
  }
  return {
    command,
    cwd,
    recorded: () => readFile(record, "utf8"),
    cleanup: async () => {
      for (const target of [directory, cwd]) {
        await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  };
}

describe("Antigravity plugin environment", () => {
  it("switches off the native self-updater for Host-started agy on Windows", () => {
    const environment = { PATH: "C:\\tools" };
    expect(antigravityProcessEnvironment(environment, "win32")).toEqual({
      PATH: "C:\\tools",
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    });
    expect(environment).toEqual({ PATH: "C:\\tools" });
  });

  it("keeps a switch the user configured, in any letter case", () => {
    for (const environment of [
      { AGY_CLI_DISABLE_AUTO_UPDATE: "false" },
      { agy_cli_disable_auto_update: "false" },
    ]) {
      expect(antigravityProcessEnvironment(environment, "win32")).toBe(environment);
    }
  });

  it("removes undefined Windows variants without losing a defined user value", () => {
    const environment = {
      AGY_CLI_DISABLE_AUTO_UPDATE: undefined,
      agy_cli_disable_auto_update: "false",
    };
    expect(antigravityProcessEnvironment(environment, "win32")).toEqual({
      agy_cli_disable_auto_update: "false",
    });
  });

  it("treats an undefined switch as unset and adds the documented default", () => {
    // Node leaves an undefined variable out of the child process environment.
    expect(
      antigravityProcessEnvironment({ AGY_CLI_DISABLE_AUTO_UPDATE: undefined }, "win32"),
    ).toEqual({ AGY_CLI_DISABLE_AUTO_UPDATE: "true" });
  });

  it("disables auto-update on macOS while preserving the exact user setting", () => {
    const environment = { AGY_CLI_DISABLE_AUTO_UPDATE: "false" };
    expect(antigravityProcessEnvironment({ PATH: "/usr/bin" }, "darwin")).toEqual({
      PATH: "/usr/bin",
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    });
    expect(antigravityProcessEnvironment(environment, "darwin")).toBe(environment);
  });

  it("leaves Linux environments unchanged", () => {
    const environment = { PATH: "/usr/bin" };
    expect(antigravityProcessEnvironment(environment, "linux")).toBe(environment);
  });

  it.each([
    ["win32", undefined, "true"],
    ["win32", "false", "false"],
    ["darwin", undefined, "true"],
    ["darwin", "false", "false"],
    ["linux", undefined, "<unset>"],
  ] as const)(
    "starts agy on %s with the switch set to the expected value (user value %s)",
    async (platform, configured, expected) => {
      const fixture = await recordingAgy();
      const adapter = createHarnessAdapter({
        environment: {
          ...environmentWithoutSwitch(),
          [ANTIGRAVITY_COMMAND_ENV]: fixture.command,
          ...(configured !== undefined
            ? { [ANTIGRAVITY_DISABLE_AUTO_UPDATE_ENV]: configured }
            : {}),
        },
        platform,
        managedRemoteHost: false,
      });
      try {
        expect((await adapter.inspect({ cwd: fixture.cwd })).status).toBe("ready");
        expect(await fixture.recorded()).toBe(expected);
      } finally {
        await adapter.close();
        await fixture.cleanup();
      }
    },
  );
});
