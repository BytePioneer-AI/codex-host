import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET,
  AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION,
  CPA_LIVE_VOICE_ENV,
  cpaLiveVoiceHookBootstrap,
  cpaLiveVoiceHookEnabled,
} from "../src/cpa-live-voice-hook.js";

let directory: string;
let environment: NodeJS.ProcessEnv;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-inject-"));
  environment = { CODEXHOST_DATA_DIR: directory };
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
  });
});
