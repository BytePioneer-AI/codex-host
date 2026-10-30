import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  RENDERER_NEW_THREAD_PREFERENCE_KEY,
  rendererNewThreadPreferenceStorage,
  readNewThreadAgentPreference,
  writeNewThreadAgentPreference,
  readNewThreadExternalConfigurationPreference,
  writeNewThreadExternalConfigurationPreference,
} from "../src/renderer-new-thread-preference.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

const model = harnessModelRefSchema.parse({ id: "grok-4.6" });
const thinkingOptionId = harnessThinkingOptionIdSchema.parse("high");
const modelCatalog = harnessModelCatalogSchema.parse({
  models: [
    {
      ref: model,
      label: "Grok 4.6",
      supportedThinkingOptionIds: [thinkingOptionId],
    },
  ],
  defaultModel: model,
  thinkingOptions: [{ id: thinkingOptionId, label: "High" }],
  defaultThinkingOptionId: thinkingOptionId,
});
const permissionModes = harnessPermissionModeCatalogSchema.parse({
  modes: [
    { id: "ask", label: "Ask" },
    { id: "auto", label: "Auto" },
    { id: "always-approve", label: "Always approve", dangerous: true },
  ],
  defaultModeId: "ask",
});

describe("Renderer new-Thread external configuration preference", () => {
  it("keeps unknown plugin preferences isolated by Host and retains the local v1 key", () => {
    const storage = memoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    try {
      const local = rendererNewThreadPreferenceStorage("local");
      const remote = rendererNewThreadPreferenceStorage("remote:ssh");
      writeNewThreadAgentPreference("third-party", local);
      writeNewThreadExternalConfigurationPreference(
        "third-party",
        model,
        undefined,
        undefined,
        local,
      );
      expect(storage.values.has(RENDERER_NEW_THREAD_PREFERENCE_KEY)).toBe(true);
      expect(readNewThreadAgentPreference(undefined, local)).toBe("third-party");
      expect(readNewThreadAgentPreference(undefined, remote)).toBeUndefined();
      expect(
        readNewThreadExternalConfigurationPreference(
          "third-party",
          modelCatalog,
          undefined,
          remote,
        ),
      ).toBeUndefined();
      writeNewThreadAgentPreference("other-plugin", remote);
      expect(readNewThreadAgentPreference(undefined, remote)).toBe("other-plugin");
      expect(readNewThreadAgentPreference(undefined, local)).toBe("third-party");
      expect(rendererNewThreadPreferenceStorage(null)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("restores Model and Thinking but keeps Fast off for a new Thread", () => {
    const storage = memoryStorage();
    const fast = harnessModelRefSchema.parse({ id: "priority" });
    const catalog = harnessModelCatalogSchema.parse({
      ...modelCatalog,
      models: modelCatalog.models.map((entry) => ({ ...entry, fastModel: fast })),
    });
    writeNewThreadExternalConfigurationPreference("pi", fast, thinkingOptionId, undefined, storage);
    expect(readNewThreadExternalConfigurationPreference("pi", catalog, undefined, storage)).toEqual(
      { model, thinkingOptionId },
    );
  });
  it("persists and restores the Grok Permission Mode with Model and Thinking", () => {
    const storage = memoryStorage();
    const permissionModeId = harnessPermissionModeIdSchema.parse("auto");

    writeNewThreadExternalConfigurationPreference(
      "grok",
      model,
      thinkingOptionId,
      permissionModeId,
      storage,
    );

    expect(storage.values.has(RENDERER_NEW_THREAD_PREFERENCE_KEY)).toBe(true);
    expect(
      readNewThreadExternalConfigurationPreference("grok", modelCatalog, permissionModes, storage),
    ).toEqual({ model, thinkingOptionId, permissionModeId });
  });

  it("drops only a Permission Mode that disappeared from the live catalog", () => {
    const storage = memoryStorage();
    writeNewThreadExternalConfigurationPreference(
      "grok",
      model,
      thinkingOptionId,
      harnessPermissionModeIdSchema.parse("removed-mode"),
      storage,
    );

    expect(
      readNewThreadExternalConfigurationPreference("grok", modelCatalog, permissionModes, storage),
    ).toEqual({ model, thinkingOptionId });
  });
});
