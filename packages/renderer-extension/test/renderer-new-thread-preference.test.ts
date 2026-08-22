import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  RENDERER_NEW_THREAD_PREFERENCE_KEY,
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
