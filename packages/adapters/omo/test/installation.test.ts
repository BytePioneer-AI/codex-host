import { describe, expect, it } from "vitest";

import type { HarnessInstallationState } from "@codexhost/shared-contracts";

import {
  createOmoInstallation,
  OMO_MANUAL_UPDATE_URL,
  OMO_UPDATE_PROBE_TIMEOUT_MS,
  OMO_UPDATE_TIMEOUT_MS,
  OMO_VERSION_TIMEOUT_MS,
  OmoVersionError,
  parseOmoUpdateProbe,
  parseOmoVersion,
} from "../src/installation.js";

/** Captured from the real omo 5.1.83 binary. */
const realVersionOutput = "omo 5.1.83 (engine: senpi 2026.11.23; scheme nodef)";
/** Captured from the real `omo update --help` (2026-11-26, omo 5.1.83). */
const realUpdateHelp = [
  "Usage: omo update [--dry-run | --print]",
  "",
  "Update omo to the newest release on its channel. The engine is pinned by omo and moves with it.",
  "",
  "Options:",
  "  --dry-run, --print  print the update command without running it",
  "  -h, --help          show this help",
].join("\n");
/** Captured from the real `omo update --dry-run` while 5.1.83 was current. */
const upToDateOutput = "omo 5.1.83 is the newest stable release";
/** The command shape `--print` documents; the update-pending branch itself is unverified. */
const pendingUpdateOutput = "curl -fsSL https://get.omo.dev/install.sh | bash";

describe("OmO version parsing", () => {
  it("reads the CLI version that follows the omo command name", () => {
    expect(parseOmoVersion(realVersionOutput)).toBe("5.1.83");
    expect(parseOmoVersion(`${realVersionOutput}\r\n`)).toBe("5.1.83");
    expect(parseOmoVersion("omo v5.1.83")).toBe("5.1.83");
    expect(parseOmoVersion(upToDateOutput)).toBe("5.1.83");
  });

  it.each(["", "omo", "omo latest", "omo v5", "engine: senpi 2026.11.23", "5.1.83"])(
    "rejects malformed output %j with a typed error",
    (output) => {
      expect(() => parseOmoVersion(output)).toThrow(OmoVersionError);
    },
  );
});

describe("OmO update probe parsing", () => {
  it("reads the native newest-release sentence and a printed update command", () => {
    expect(parseOmoUpdateProbe(upToDateOutput)).toEqual({ status: "current", version: "5.1.83" });
    expect(parseOmoUpdateProbe(`${upToDateOutput}\n`)).toEqual({
      status: "current",
      version: "5.1.83",
    });
    expect(parseOmoUpdateProbe(pendingUpdateOutput)).toEqual({ status: "available" });
    expect(parseOmoUpdateProbe("irm https://get.omo.dev/install.ps1 | iex")).toEqual({
      status: "available",
    });
    expect(parseOmoUpdateProbe("bun add -g omo-ai")).toEqual({ status: "available" });
  });

  it.each([
    "",
    "omo 5.2.0",
    "update printed",
    "no update information available",
    "omo is the newest stable release",
  ])("treats unrecognized probe output %j as unknown", (output) => {
    expect(parseOmoUpdateProbe(output)).toEqual({ status: "unknown" });
  });
});

type FakeResponse =
  string | Error | Promise<string | Error> | (() => string | Error | Promise<string | Error>);

function fakeOmo(responses: Record<string, FakeResponse>) {
  const calls: string[][] = [];
  const timeouts: (number | undefined)[] = [];
  const runCommand = async (
    _command: string,
    args: readonly string[],
    _environment: NodeJS.ProcessEnv,
    timeout?: number,
  ): Promise<string> => {
    calls.push([...args]);
    timeouts.push(timeout);
    const key = args.join(" ");
    const entry = responses[key];
    if (entry === undefined) throw new Error(`unexpected omo invocation: ${key}`);
    const value = await (typeof entry === "function" ? entry() : entry);
    if (value instanceof Error) throw value;
    return value;
  };
  return { calls, timeouts, runCommand };
}

function installationFor(
  responses: Record<string, FakeResponse>,
  options: { channelConfirmed?: boolean } = {},
) {
  const fake = fakeOmo(responses);
  const installation = createOmoInstallation({ PATH: "/fake/bin" }, "/chosen/omo", {
    resolveExecutable: () => "/chosen/omo",
    runCommand: fake.runCommand,
    ...(options.channelConfirmed ? { updateChannelConfirmed: true } : {}),
  });
  return { fake, installation };
}

describe("OmO installation check", () => {
  it("reports the installed and native latest version but offers no automatic update while the channel is unverified", async () => {
    const { fake, installation } = installationFor({
      "--version": realVersionOutput,
      "update --help": realUpdateHelp,
      "update --dry-run": upToDateOutput,
    });

    const state = await installation("check");
    expect(state).toMatchObject({
      currentVersion: "5.1.83",
      latestVersion: "5.1.83",
      updateAvailable: false,
      canUpdate: false,
      manualUpdateUrl: OMO_MANUAL_UPDATE_URL,
      messageCode: "omo-update-channel-unverified",
    });
    expect(state.latestVersionKind).toBeUndefined();
    expect(state.notice?.en).toBeTruthy();
    expect(state.notice?.["zh-CN"]).toBeTruthy();
    expect(fake.calls).toEqual([["--version"], ["update", "--help"], ["update", "--dry-run"]]);
    expect(fake.timeouts).toEqual([
      OMO_VERSION_TIMEOUT_MS,
      OMO_UPDATE_PROBE_TIMEOUT_MS,
      OMO_UPDATE_PROBE_TIMEOUT_MS,
    ]);
  });

  it("fails without spawning when the CLI cannot be resolved", async () => {
    let spawned = false;
    const installation = createOmoInstallation({}, undefined, {
      resolveExecutable: () => undefined,
      runCommand: async () => {
        spawned = true;
        return realVersionOutput;
      },
    });
    await expect(installation("check")).rejects.toThrow(/omo CLI was not found/u);
    expect(spawned).toBe(false);
  });

  it("rejects a version output the CLI cannot parse", async () => {
    const { installation } = installationFor({ "--version": "senpi 2026.11.23" });
    await expect(installation("check")).rejects.toThrow(OmoVersionError);
  });

  it("degrades a release without a non-interactive check to the manual route", async () => {
    const { fake, installation } = installationFor(
      {
        "--version": realVersionOutput,
        "update --help": "Usage: omo update\n\nOptions:\n  -h, --help  show this help",
      },
      { channelConfirmed: true },
    );

    await expect(installation("check")).resolves.toMatchObject({
      currentVersion: "5.1.83",
      latestVersion: "Unknown",
      latestVersionKind: "unknown",
      updateAvailable: false,
      canUpdate: false,
      manualUpdateUrl: OMO_MANUAL_UPDATE_URL,
      messageCode: "omo-update-check-unavailable",
    });
    expect(fake.calls.map((args) => args.join(" "))).toEqual(["--version", "update --help"]);
  });

  it("treats a failing update help as an unavailable check", async () => {
    const { installation } = installationFor({
      "--version": realVersionOutput,
      "update --help": new Error("unknown command"),
    });
    await expect(installation("check")).resolves.toMatchObject({
      latestVersion: "Unknown",
      latestVersionKind: "unknown",
      updateAvailable: false,
      canUpdate: false,
      messageCode: "omo-update-check-unavailable",
    });
  });

  it("never claims a latest version when the native check is unreadable", async () => {
    for (const options of [{}, { channelConfirmed: true }]) {
      const { fake, installation } = installationFor(
        {
          "--version": realVersionOutput,
          "update --help": realUpdateHelp,
          "update --dry-run": "no update information available",
        },
        options,
      );
      await expect(installation("check")).resolves.toMatchObject({
        currentVersion: "5.1.83",
        latestVersion: "Unknown",
        latestVersionKind: "unknown",
        updateAvailable: false,
        canUpdate: false,
        manualUpdateUrl: OMO_MANUAL_UPDATE_URL,
        messageCode: "omo-update-status-unknown",
      });
      // Nothing is pending, so the update action must not spawn the native updater.
      await expect(installation("update")).resolves.toMatchObject({ updateAvailable: false });
      expect(fake.calls.some((args) => args.join(" ") === "update")).toBe(false);
    }
  });

  it("keeps the installed version when the native update check fails", async () => {
    const { installation } = installationFor({
      "--version": realVersionOutput,
      "update --help": realUpdateHelp,
      "update --dry-run": new Error("Harness command timed out"),
    });
    const state = await installation("check");
    expect(state).toMatchObject({
      currentVersion: "5.1.83",
      latestVersion: "Unknown",
      updateAvailable: false,
      canUpdate: false,
      message: "Harness command timed out",
    });
  });

  it("merges concurrent checks into one version read", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let versionCalls = 0;
    const { installation } = installationFor({
      "--version": async () => {
        versionCalls += 1;
        await gate;
        return realVersionOutput;
      },
      "update --help": realUpdateHelp,
      "update --dry-run": upToDateOutput,
    });

    const first = installation("check");
    const second = installation("check");
    expect(versionCalls).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(versionCalls).toBe(1);
  });
});

describe("OmO installation update orchestration", () => {
  it("offers no automatic update once up to date on a confirmed channel", async () => {
    const { fake, installation } = installationFor(
      {
        "--version": realVersionOutput,
        "update --help": realUpdateHelp,
        "update --dry-run": upToDateOutput,
      },
      { channelConfirmed: true },
    );

    await expect(installation("check")).resolves.toMatchObject({
      currentVersion: "5.1.83",
      latestVersion: "5.1.83",
      updateAvailable: false,
      canUpdate: true,
    });
    const state: HarnessInstallationState = await installation("check");
    expect(state.manualUpdateUrl).toBeUndefined();
    await expect(installation("update", "5.1.83")).resolves.toMatchObject({
      currentVersion: "5.1.83",
      updateAvailable: false,
    });
    expect(fake.calls.some((args) => args.join(" ") === "update")).toBe(false);
  });

  it("runs omo update once on a confirmed channel and verifies the version changed", async () => {
    let version = "5.1.83";
    const { fake, installation } = installationFor(
      {
        "--version": () => `omo ${version} (engine: senpi 2026.11.23; scheme nodef)`,
        "update --help": realUpdateHelp,
        "update --dry-run": () =>
          version === "5.1.83"
            ? pendingUpdateOutput
            : `omo ${version} is the newest stable release`,
        update: () => {
          version = "5.2.0";
          return "omo updated";
        },
      },
      { channelConfirmed: true },
    );

    await expect(installation("check")).resolves.toMatchObject({
      currentVersion: "5.1.83",
      latestVersion: "Unknown",
      latestVersionKind: "unknown",
      updateAvailable: true,
      canUpdate: true,
    });
    await expect(installation("update")).resolves.toMatchObject({
      currentVersion: "5.2.0",
      latestVersion: "5.2.0",
      updateAvailable: false,
      canUpdate: true,
    });
    expect(fake.calls.filter((args) => args.join(" ") === "update")).toHaveLength(1);
    // Initial check, pre-update check, and the post-update readback.
    expect(fake.calls.filter((args) => args[0] === "--version")).toHaveLength(3);
    const updateCall = fake.calls.findIndex((args) => args.join(" ") === "update");
    expect(fake.calls.findLastIndex((args) => args[0] === "--version")).toBeGreaterThan(updateCall);
    expect(fake.timeouts[updateCall]).toBe(OMO_UPDATE_TIMEOUT_MS);
  });

  it("never runs the updater on an unverified channel, even when an update is pending", async () => {
    const { fake, installation } = installationFor({
      "--version": realVersionOutput,
      "update --help": realUpdateHelp,
      "update --dry-run": pendingUpdateOutput,
    });

    await expect(installation("check")).resolves.toMatchObject({
      latestVersion: "Unknown",
      latestVersionKind: "unknown",
      updateAvailable: true,
      canUpdate: false,
      manualUpdateUrl: OMO_MANUAL_UPDATE_URL,
    });
    await expect(installation("update")).rejects.toThrow(/update channel is not verified/u);
    expect(fake.calls.some((args) => args.join(" ") === "update")).toBe(false);
  });

  it("rejects instead of reporting success when the native updater fails", async () => {
    const { installation } = installationFor(
      {
        "--version": realVersionOutput,
        "update --help": realUpdateHelp,
        "update --dry-run": pendingUpdateOutput,
        update: new Error("Harness command failed; check the native installation and retry"),
      },
      { channelConfirmed: true },
    );

    await expect(installation("update")).rejects.toThrow(/Harness command failed/u);
    // A failed update leaves the reported version untouched.
    await expect(installation("check")).resolves.toMatchObject({
      currentVersion: "5.1.83",
      updateAvailable: true,
    });
  });

  it("rejects when the version does not change after the native update", async () => {
    const { fake, installation } = installationFor(
      {
        "--version": realVersionOutput,
        "update --help": realUpdateHelp,
        "update --dry-run": pendingUpdateOutput,
        update: "omo 5.1.83 is the newest stable release",
      },
      { channelConfirmed: true },
    );

    await expect(installation("update")).rejects.toThrow(/did not change/u);
    expect(fake.calls.filter((args) => args.join(" ") === "update")).toHaveLength(1);
  });

  it("merges concurrent update requests into one native run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let version = "5.1.83";
    const { fake, installation } = installationFor(
      {
        "--version": () => `omo ${version} (engine: senpi 2026.11.23; scheme nodef)`,
        "update --help": realUpdateHelp,
        "update --dry-run": () =>
          version === "5.1.83"
            ? pendingUpdateOutput
            : `omo ${version} is the newest stable release`,
        update: async () => {
          await gate;
          version = "5.2.0";
          return "omo updated";
        },
      },
      { channelConfirmed: true },
    );

    const first = installation("update");
    const second = installation("update");
    const duringUpdate = installation("check");
    release();
    const [a, b, c] = await Promise.all([first, second, duringUpdate]);

    expect(a).toMatchObject({ currentVersion: "5.2.0", updateAvailable: false });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(fake.calls.filter((args) => args.join(" ") === "update")).toHaveLength(1);
  });
});
