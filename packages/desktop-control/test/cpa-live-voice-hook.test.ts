import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  existsSync: vi.fn(),
}));

import {
  AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET,
  AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION,
  CPA_LIVE_VOICE_ENV,
  DESKTOP_VERSION_ENV,
  cpaLiveVoiceHookBootstrap,
  cpaLiveVoiceHookEnabled,
  detectInstalledDesktopVersion,
} from "../src/cpa-live-voice-hook.js";

let directory: string;
let environment: NodeJS.ProcessEnv;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-inject-"));
  environment = { CODEXHOST_DATA_DIR: directory };
});

describe("installed Desktop version detection", () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!platformDescriptor) throw new Error("process.platform descriptor is missing");

  beforeEach(() => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
    vi.mocked(existsSync).mockReset().mockReturnValue(false);
    vi.mocked(execFileSync).mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
  });

  it.each([
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    "/test-home/Applications/ChatGPT.app",
    "/test-home/Applications/Codex.app",
  ])("reads the short version from %s/Contents/Info.plist", (app) => {
    const plist = path.join(app, "Contents/Info.plist");
    vi.mocked(existsSync).mockImplementation((candidate) => candidate === plist);
    vi.mocked(execFileSync).mockReturnValue("26.1021.31345\n");

    const version = detectInstalledDesktopVersion({ HOME: "/test-home" });

    expect(version).toBe("26.1021.31345");
    expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
      "/usr/bin/defaults",
      ["read", plist, "CFBundleShortVersionString"],
      { encoding: "utf8", timeout: 2000 },
    );
    expect(cpaLiveVoiceHookBootstrap(environment, version)).toContain(
      '"desktopVersion":"26.1021.31345"',
    );
    expect(cpaLiveVoiceHookBootstrap({ ...environment, HOME: "/test-home" })).toContain(
      '"desktopVersion":"26.1021.31345"',
    );
  });

  it("does not read installed apps when the hook is disabled", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execFileSync).mockReturnValue("26.1021.31345\n");
    expect(cpaLiveVoiceHookBootstrap({ [CPA_LIVE_VOICE_ENV]: "0" })).toBe("");
    expect(existsSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("uses the trimmed env override without reading installed apps", () => {
    expect(detectInstalledDesktopVersion({ [DESKTOP_VERSION_ENV]: " 26.1021.31345 " })).toBe(
      "26.1021.31345",
    );
    expect(existsSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("tries the next installed app when a plist read fails", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => {
        throw new Error("unreadable plist");
      })
      .mockReturnValueOnce("26.1021.31345\n");

    expect(detectInstalledDesktopVersion({ HOME: "/test-home" })).toBe("26.1021.31345");
    expect(execFileSync).toHaveBeenNthCalledWith(
      2,
      "/usr/bin/defaults",
      [
        "read",
        path.join("/Applications/Codex.app", "Contents/Info.plist"),
        "CFBundleShortVersionString",
      ],
      { encoding: "utf8", timeout: 2000 },
    );
  });

  it("returns undefined when no installed plist exists", () => {
    expect(detectInstalledDesktopVersion({ HOME: "/test-home" })).toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("does not run defaults on other platforms", () => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    expect(detectInstalledDesktopVersion({})).toBeUndefined();
    expect(existsSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("CPA live-voice controller bootstrap", () => {
  it("defaults on when no setting exists, and accepts explicit env overrides", () => {
    expect(cpaLiveVoiceHookEnabled(environment)).toBe(true);
    expect(cpaLiveVoiceHookEnabled({ ...environment, [CPA_LIVE_VOICE_ENV]: "1" })).toBe(true);
    expect(cpaLiveVoiceHookEnabled({ [CPA_LIVE_VOICE_ENV]: "0" })).toBe(false);
    expect(cpaLiveVoiceHookBootstrap({ [CPA_LIVE_VOICE_ENV]: "0" })).toBe("");
  });

  it("reads the inject file when the env is unset, and env still wins", async () => {
    await writeFile(
      path.join(directory, "live-voice-inject-v1.json"),
      JSON.stringify({ version: 1, inject: false }),
    );
    expect(cpaLiveVoiceHookEnabled(environment)).toBe(false);
    expect(cpaLiveVoiceHookBootstrap(environment)).toBe("");
    expect(cpaLiveVoiceHookEnabled({ ...environment, [CPA_LIVE_VOICE_ENV]: "1" })).toBe(true);
    expect(cpaLiveVoiceHookEnabled({ ...environment, [CPA_LIVE_VOICE_ENV]: "0" })).toBe(false);
  });

  it.each([
    "invalid json",
    "null",
    "{}",
    '{"version":2,"inject":false}',
    '{"version":1,"inject":"false"}',
  ])("defaults on for malformed or unsupported settings: %s", async (content) => {
    await writeFile(path.join(directory, "live-voice-inject-v1.json"), content);
    expect(cpaLiveVoiceHookEnabled(environment)).toBe(true);
  });

  it("emits a frozen enable record by default", () => {
    const source = cpaLiveVoiceHookBootstrap(environment);
    expect(source.startsWith("globalThis.__codexhostCpaLiveVoiceHookV1 = Object.freeze(")).toBe(
      true,
    );
    expect(source).toContain(`"auditedDesktopVersion":"${AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION}"`);
    expect(source).toContain(
      `"auditedAppInitialAsset":"${AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET}"`,
    );
    expect(source).toContain('"enabled":true');
    expect(source).not.toContain("clientOwnsCall");
    expect(source).not.toContain("function pa");
    expect(source).not.toContain("desktopVersion");
  });

  it("includes the Desktop short version from env", () => {
    const source = cpaLiveVoiceHookBootstrap({
      ...environment,
      [DESKTOP_VERSION_ENV]: "26.1021.31345",
    });
    expect(source).toContain('"desktopVersion":"26.1021.31345"');
  });
});
