import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LIVE_VOICE_INJECT_FILE,
  readLiveVoiceInjectState,
  writeLiveVoiceInjectFile,
} from "../src/live-voice-inject.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-live-voice-setting-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("live voice injection setting", () => {
  it("defaults on, persists both values, and leaves only the published file", async () => {
    expect(await readLiveVoiceInjectState(directory, {})).toEqual({
      inject: true,
      savedInject: true,
      envOverride: null,
    });
    for (const inject of [false, true]) {
      await writeLiveVoiceInjectFile(directory, inject);
      expect(
        JSON.parse(await readFile(path.join(directory, LIVE_VOICE_INJECT_FILE), "utf8")),
      ).toEqual({ version: 1, inject });
      expect(await readLiveVoiceInjectState(directory, {})).toEqual({
        inject,
        savedInject: inject,
        envOverride: null,
      });
    }
    expect(await readdir(directory)).toEqual([LIVE_VOICE_INJECT_FILE]);
    if (process.platform !== "win32") {
      expect((await stat(path.join(directory, LIVE_VOICE_INJECT_FILE))).mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    "invalid json",
    "null",
    "{}",
    '{"version":2,"inject":false}',
    '{"version":1,"inject":"false"}',
  ])("defaults on for malformed or unsupported settings: %s", async (content) => {
    await writeFile(path.join(directory, LIVE_VOICE_INJECT_FILE), content);
    expect(await readLiveVoiceInjectState(directory, {})).toEqual({
      inject: true,
      savedInject: true,
      envOverride: null,
    });
  });

  it("gives explicit env overrides precedence without changing the saved value", async () => {
    await writeLiveVoiceInjectFile(directory, false);
    expect(await readLiveVoiceInjectState(directory, { CODEXHOST_CPA_LIVE_VOICE: "1" })).toEqual({
      inject: true,
      savedInject: false,
      envOverride: "1",
    });
    await writeLiveVoiceInjectFile(directory, true);
    expect(await readLiveVoiceInjectState(directory, { CODEXHOST_CPA_LIVE_VOICE: "0" })).toEqual({
      inject: false,
      savedInject: true,
      envOverride: "0",
    });
    expect(
      await readLiveVoiceInjectState(directory, { CODEXHOST_CPA_LIVE_VOICE: "other" }),
    ).toEqual({ inject: true, savedInject: true, envOverride: null });
  });

  it("reports publication failure and cleans up the temporary file", async () => {
    await mkdir(path.join(directory, LIVE_VOICE_INJECT_FILE));
    await expect(writeLiveVoiceInjectFile(directory, false)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([LIVE_VOICE_INJECT_FILE]);
  });
});
