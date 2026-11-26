import { describe, expect, it } from "vitest";

import {
  createOmoInstallation,
  OMO_VERSION_TIMEOUT_MS,
  OmoVersionError,
  parseOmoVersion,
} from "../src/installation.js";

const realOutput = "omo 5.1.83 (engine: senpi 2026.11.23; scheme nodef)";

describe("OmO version parsing", () => {
  it("reads the CLI version that follows the omo command name", () => {
    expect(parseOmoVersion(realOutput)).toBe("5.1.83");
    expect(parseOmoVersion(`${realOutput}\r\n`)).toBe("5.1.83");
    expect(parseOmoVersion("omo v5.1.83")).toBe("5.1.83");
  });

  it.each(["", "omo", "omo latest", "omo v5", "engine: senpi 2026.11.23"])(
    "rejects malformed output %j with a typed error",
    (output) => {
      expect(() => parseOmoVersion(output)).toThrow(OmoVersionError);
    },
  );
});

describe("OmO version check", () => {
  it("reports the installed version and an unknown latest version without update support", async () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      environment: NodeJS.ProcessEnv;
      timeout: number | undefined;
    }> = [];
    const environment = { PATH: "/fake/bin" };
    const installation = createOmoInstallation(environment, "/chosen/omo", {
      resolveExecutable: () => "/chosen/omo",
      runCommand: async (command, args, runEnvironment, timeout) => {
        calls.push({ command, args, environment: runEnvironment, timeout });
        return realOutput;
      },
    });

    await expect(installation("check")).resolves.toMatchObject({
      currentVersion: "5.1.83",
      latestVersion: "Unknown",
      latestVersionKind: "unknown",
      updateAvailable: false,
      canUpdate: false,
    });
    expect(calls).toEqual([
      {
        command: "/chosen/omo",
        args: ["--version"],
        environment,
        timeout: OMO_VERSION_TIMEOUT_MS,
      },
    ]);
    const state = await installation("check");
    expect(state.notice?.en).toBeTruthy();
    expect(state.notice?.["zh-CN"]).toBeTruthy();
  });

  it("fails without spawning when the CLI cannot be resolved", async () => {
    let spawned = false;
    const installation = createOmoInstallation({}, undefined, {
      resolveExecutable: () => undefined,
      runCommand: async () => {
        spawned = true;
        return realOutput;
      },
    });
    await expect(installation("check")).rejects.toThrow(/omo CLI was not found/u);
    expect(spawned).toBe(false);
  });

  it("rejects a version output the CLI cannot parse", async () => {
    const installation = createOmoInstallation({}, "/chosen/omo", {
      resolveExecutable: () => "/chosen/omo",
      runCommand: async () => "senpi 2026.11.23",
    });
    await expect(installation("check")).rejects.toThrow(OmoVersionError);
  });

  it("merges concurrent checks into one version read", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const installation = createOmoInstallation({}, "/chosen/omo", {
      resolveExecutable: () => "/chosen/omo",
      runCommand: async () => {
        calls += 1;
        await gate;
        return realOutput;
      },
    });

    const first = installation("check");
    const second = installation("check");
    expect(calls).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
  });

  it("returns the non-updatable state for update requests in v1", async () => {
    let calls = 0;
    const installation = createOmoInstallation({}, "/chosen/omo", {
      resolveExecutable: () => "/chosen/omo",
      runCommand: async () => {
        calls += 1;
        return realOutput;
      },
    });
    await expect(installation("update")).resolves.toMatchObject({
      currentVersion: "5.1.83",
      updateAvailable: false,
      canUpdate: false,
    });
    expect(calls).toBe(1);
  });
});
