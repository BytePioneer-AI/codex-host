import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessDisplaySettingsStore } from "../src/harness-display-settings.js";

describe("shared Harness display settings", () => {
  it("shares writes across Hosts, migrates once, and persists an explicit reset", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "harness-display-"));
    try {
      const desktop = new HarnessDisplaySettingsStore({ CODEXHOST_DATA_DIR: directory });
      const web = new HarnessDisplaySettingsStore({ CODEXHOST_DATA_DIR: directory });
      expect(await desktop.get()).toEqual({ entries: null });
      const legacy = [{ agent: "pi", section: "more" as const }];
      await desktop.set({ entries: legacy, initializeOnly: true });
      expect(await web.get()).toEqual({ entries: legacy });
      const edited = [{ agent: "grok", section: "main" as const }];
      await web.set({ entries: edited });
      expect(await desktop.set({ entries: legacy, initializeOnly: true })).toEqual({
        entries: edited,
      });
      await web.set({ entries: [] });
      expect(await desktop.set({ entries: legacy, initializeOnly: true })).toEqual({ entries: [] });
      expect(
        await new HarnessDisplaySettingsStore({ CODEXHOST_DATA_DIR: directory }).get(),
      ).toEqual({ entries: [] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("does not overwrite a concurrent initial migration", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "harness-display-"));
    try {
      const store = new HarnessDisplaySettingsStore({ CODEXHOST_DATA_DIR: directory });
      const first = [{ agent: "pi", section: "more" as const }];
      const second = [{ agent: "grok", section: "main" as const }];
      await Promise.all([
        store.set({ entries: first, initializeOnly: true }),
        store.set({ entries: second, initializeOnly: true }),
      ]);
      const result = await store.get();
      expect([first, second]).toContainEqual(result.entries);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("reports corrupt shared settings rather than replacing them with legacy data", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "harness-display-"));
    try {
      await writeFile(path.join(directory, "harness-display-settings-v1.json"), "invalid");
      const store = new HarnessDisplaySettingsStore({ CODEXHOST_DATA_DIR: directory });
      await expect(store.get()).rejects.toThrow("Could not read");
      await expect(store.set({ entries: [], initializeOnly: true })).rejects.toThrow(
        "Could not read",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
