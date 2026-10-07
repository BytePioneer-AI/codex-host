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

  it("ignores corrupt legacy data", () => {
    const store = createAgentGroupPreferenceStore({ getItem: () => "invalid JSON" });
    expect(store.legacyEntries()).toEqual(createAgentGroupPreferenceStore(null).legacyEntries());
  });
});
