import { describe, expect, it, vi } from "vitest";
import {
  AGENT_GROUP_PREFERENCE_STORAGE_KEY,
  createAgentGroupPreferenceStore,
} from "../src/agent-group-preference.js";

describe("Host-confirmed Agent grouping", () => {
  it("folds only confirmed missing installations by default", () => {
    const store = createAgentGroupPreferenceStore(null);
    expect(store.list(new Set(["pi"]))).toEqual([]); // No synthesized built-in Harness entries.
    expect(store.sectionOf("pi", true)).toBe("more");
    expect(store.sectionOf("pi", false)).toBe("main");
  });

  it("reads legacy preferences only for migration and never writes browser storage", () => {
    const storage = {
      getItem: vi.fn(() => JSON.stringify([{ agent: "pi", section: "more" }])),
      setItem: vi.fn(),
    };
    const store = createAgentGroupPreferenceStore(storage);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(store.sectionOf("pi")).toBe("main");
    expect(store.legacyEntries()[0]).toEqual({ agent: "pi", section: "more" });
    expect(storage.getItem).toHaveBeenCalledWith(AGENT_GROUP_PREFERENCE_STORAGE_KEY);
    store.replace([{ agent: "grok", section: "more" }]);
    expect(store.sectionOf("grok")).toBe("more");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("does not modify ordering without a Host writer, including on failure or disposal", () => {
    const store = createAgentGroupPreferenceStore(null);
    const original = store.list();
    for (const status of ["loading", "ready", "error", "saving"] as const) {
      store.setSyncStatus(status);
      store.moveAgent("grok", "more", "pi");
      store.resetToDefault();
      expect(store.list()).toEqual(original);
    }
  });

  it("sends changes to the Host and applies only confirmed results", () => {
    const store = createAgentGroupPreferenceStore(null);
    const writer = vi.fn();
    store.setWriter(writer);
    store.setSyncStatus("ready");
    store.moveAgent("grok", "more", "pi");
    expect(writer).toHaveBeenCalledOnce();
    expect(store.sectionOf("grok")).toBe("main");
    const [entries] = writer.mock.calls[0] ?? [];
    store.replace(entries);
    expect(store.sectionOf("grok")).toBe("more");
    store.resetToDefault();
    expect(writer).toHaveBeenLastCalledWith([]);
    store.replace([]);
    expect(store.sectionOf("grok")).toBe("main");
    store.setWriter(null);
    store.moveAgent("pi", "more");
    expect(store.sectionOf("pi")).toBe("main");
  });

  it("orders only discovered plugins, with new plugins appended by name", () => {
    const store = createAgentGroupPreferenceStore(null);
    const catalog = [
      { id: "z-new", name: "Alpha" },
      { id: "grok", name: "Grok" },
      { id: "claude-code", name: "Claude Code" },
      { id: "a-new", name: "Zulu" },
      { id: "pi", name: "Pi" },
      { id: "codex", name: "Codex" },
    ];
    expect(store.list(new Set(["pi"]), catalog)).toEqual([
      { agent: "pi", section: "more" },
      { agent: "claude-code", section: "main" },
      { agent: "grok", section: "main" },
      { agent: "z-new", section: "main" },
      { agent: "a-new", section: "main" },
    ]);
    expect(store.list()).toEqual([]);
    store.replace([{ agent: "removed-plugin", section: "main" }]);
    expect(store.list(undefined, [])).toEqual([]);
  });

  it("preserves custom order and groups, appending unrecorded plugins in default order", () => {
    const store = createAgentGroupPreferenceStore(null);
    store.replace([
      { agent: "grok", section: "more" },
      { agent: "claude-code", section: "main" },
    ]);
    const catalog = ["opencode", "pi", "claude-code", "grok"].map((id) => ({ id, name: id }));
    expect(store.list(undefined, catalog).map(({ agent }) => agent)).toEqual([
      "grok",
      "claude-code",
      "pi",
      "opencode",
    ]);
    expect(store.list(undefined, catalog)[0]?.section).toBe("more");
  });

  it("moves relative to default rows and restores defaults after Host confirmation", () => {
    const store = createAgentGroupPreferenceStore(null);
    const catalog = ["grok", "claude-code", "pi"].map((id) => ({ id, name: id }));
    const writer = vi.fn();
    store.setWriter(writer);
    store.setSyncStatus("ready");
    store.moveAgent("grok", "main", "claude-code", catalog);
    const [entries] = writer.mock.calls[0] ?? [];
    expect(entries).toEqual([
      { agent: "pi", section: "auto" },
      { agent: "grok", section: "main" },
      { agent: "claude-code", section: "auto" },
    ]);
    expect(store.list(undefined, catalog).map(({ agent }) => agent)).toEqual([
      "pi",
      "claude-code",
      "grok",
    ]);
    store.replace(entries);
    expect(store.list(undefined, catalog).map(({ agent }) => agent)).toEqual([
      "pi",
      "grok",
      "claude-code",
    ]);
    store.resetToDefault();
    expect(writer).toHaveBeenLastCalledWith([]);
    store.replace([]);
    expect(store.list(undefined, catalog).map(({ agent }) => agent)).toEqual([
      "pi",
      "claude-code",
      "grok",
    ]);
  });

  it("ignores corrupt legacy data", () => {
    const store = createAgentGroupPreferenceStore({ getItem: () => "invalid JSON" });
    expect(store.legacyEntries()).toEqual(createAgentGroupPreferenceStore(null).legacyEntries());
  });
});
