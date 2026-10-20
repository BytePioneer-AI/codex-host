import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { VoiceSettingsStore } from "../src/voice-settings.js";
import { LIVE_VOICE_INJECT_FILE, writeLiveVoiceInjectFile } from "../src/live-voice-inject.js";

let directory: string;
let store: VoiceSettingsStore;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "voice-shared-"));
  store = new VoiceSettingsStore(directory);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const routes = {
  chatExperience: "chatgpt",
  chatConnection: "desktop",
  workConnection: "desktop",
} as const;

it("migrates Desktop choices once, preserving injection and subsequent console edits", async () => {
  await writeLiveVoiceInjectFile(directory, false);
  expect((await store.read()).initialized).toBe(false);
  const migrated = await store.write({ operation: "migrate", routes });
  expect(migrated.settings).toEqual({ ...routes, inject: false });
  const saved = await store.write({
    operation: "set",
    revision: migrated.revision,
    settings: { ...migrated.settings, chatExperience: "codex", chatConnection: "gateway" },
  });
  expect((await store.write({ operation: "migrate", routes })).settings).toEqual(saved.settings);
  expect((await new VoiceSettingsStore(directory).read()).settings).toEqual(saved.settings);
  await writeLiveVoiceInjectFile(directory, true);
  expect((await store.read()).settings).toEqual({ ...saved.settings, inject: true });
});

it("serializes competing migration and edits, and rejects stale revisions", async () => {
  const current = await store.read();
  const result = await Promise.allSettled([
    store.write({
      operation: "set",
      revision: current.revision,
      settings: { ...routes, inject: true },
    }),
    store.write({ operation: "migrate", routes: { ...routes, workConnection: "gateway" } }),
    store.write({
      operation: "set",
      revision: current.revision,
      settings: { ...routes, inject: false },
    }),
  ]);
  expect(result.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
  expect((await store.read()).settings.workConnection).toBe("desktop");
});

it("guards active calls and reports only acknowledged runtime revisions", async () => {
  const state = await store.read();
  store.report({ id: "runtime", revision: "old", activeCall: true });
  expect(await store.read()).toMatchObject({ activeCall: true, routesActive: false });
  await expect(
    store.write({
      operation: "set",
      revision: state.revision,
      settings: { ...routes, inject: true },
    }),
  ).rejects.toThrow("End your voice call");
  store.report({ id: "runtime", revision: state.revision, activeCall: false });
  expect(await store.read()).toMatchObject({ activeCall: false, routesActive: true });
});

it("defaults malformed routes without dropping a valid injection preference", async () => {
  await writeFile(
    path.join(directory, LIVE_VOICE_INJECT_FILE),
    JSON.stringify({ version: 1, inject: false, routes: { chatExperience: "invalid" } }),
  );
  expect(await store.read()).toMatchObject({
    initialized: false,
    settings: { inject: false, chatExperience: "chatgpt" },
  });
  const saved = await store.write({ operation: "migrate", routes });
  expect(JSON.parse(await readFile(path.join(directory, LIVE_VOICE_INJECT_FILE), "utf8"))).toEqual({
    version: 1,
    inject: false,
    routes,
  });
  expect(saved.initialized).toBe(true);
});
