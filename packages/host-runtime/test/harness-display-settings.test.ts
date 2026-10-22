import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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

it("notifies only confirmed changes and observes another Host's atomic writes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "harness-display-events-"));
  const observer = new HarnessDisplaySettingsStore({ CODEXHOST_DATA_DIR: directory });
  const writer = new HarnessDisplaySettingsStore({ CODEXHOST_DATA_DIR: directory });
  try {
    let changes = 0;
    const remove = await observer.subscribe(() => {
      changes++;
    });
    await writer.set({ entries: [{ agent: "pi", section: "more" }] });
    await vi.waitFor(() => expect(changes).toBe(1));
    await observer.set({ entries: [{ agent: "pi", section: "more" }] });
    expect(changes).toBe(1);
    await expect(observer.set({ entries: [{ agent: "", section: "more" }] })).rejects.toThrow();
    expect(changes).toBe(1);
    remove();
    await observer.set({ entries: [] });
    expect(changes).toBe(1);
  } finally {
    observer.close();
    writer.close();
    await rm(directory, { recursive: true, force: true });
  }
});
