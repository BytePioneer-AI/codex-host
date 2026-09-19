import { describe, expect, it } from "vitest";
import { harnessModelCatalogSchema } from "@codexhost/shared-contracts";
import { modelRef } from "@codexhost/adapter-codebuddy";
import {
  loadWorkBuddyLiveProductSnapshot,
  mergeWorkBuddyProductModels,
  parseWorkBuddyProductModels,
  sanitizeWorkBuddyProductEnvironment,
} from "../src/product-models.js";

describe("WorkBuddy product Model metadata", () => {
  it("reads only bounded public Model metadata and deduplicates native IDs", () => {
    expect(
      parseWorkBuddyProductModels({
        agents: [{ name: "cli", models: ["glm-5.2", "missing-name"] }],
        models: [
          { id: "glm-5.2", name: "GLM-5.2", credits: "x0.79 credits", endpoint: "secret" },
          { id: "glm-5.2", name: "duplicate" },
          { id: "not-for-cli", name: "Internal Model" },
          { id: "", name: "invalid" },
          { id: "missing-name" },
        ],
      }),
    ).toEqual([{ id: "glm-5.2", name: "GLM-5.2", credits: "x0.79 credits" }]);
  });

  it("does not treat top-level Models as the CLI catalog without a resolved cli Agent", () => {
    expect(
      parseWorkBuddyProductModels({ models: [{ id: "internal", name: "Internal Model" }] }),
    ).toEqual([]);
  });

  it("loads a bounded in-memory snapshot through the native launcher helper", async () => {
    const serialized = JSON.stringify({
      agents: [{ name: "cli", models: ["glm-5.2"] }],
      models: [{ id: "glm-5.2", name: "GLM-5.2", credits: "x0.79 credits" }],
    });
    await expect(
      loadWorkBuddyLiveProductSnapshot(
        { CODEXHOST_LAUNCHER_EXECUTABLE: "C:\\codexhost\\codexhost.exe" },
        "D:\\WorkBuddy\\WorkBuddyAI.exe",
        async (launcher, executable) => {
          expect(launcher).toBe("C:\\codexhost\\codexhost.exe");
          expect(executable).toBe("D:\\WorkBuddy\\WorkBuddyAI.exe");
          return serialized;
        },
      ),
    ).resolves.toEqual({
      serialized,
      models: [{ id: "glm-5.2", name: "GLM-5.2", credits: "x0.79 credits" }],
    });
  });

  it("removes every inherited product snapshot before resolving the Windows App", () => {
    expect(
      sanitizeWorkBuddyProductEnvironment({
        KEEP: "yes",
        ACC_PRODUCT_CONFIG_PATH: "C:\\stale.json",
        ACC_PRODUCT_CONFIG_V3: "stale-v3",
        ACC_PRODUCT_CONFIG_V2: "stale-v2",
        ACC_PRODUCT_CONFIG: "stale-v1",
      }),
    ).toEqual({ KEEP: "yes", CODEXHOST_WORKBUDDY_DISABLE_PRODUCT_CACHE: "1" });
  });

  it("keeps ACP Models first and adds deduplicated live product Models for selection", () => {
    const catalog = harnessModelCatalogSchema.parse({
      models: [{ ref: modelRef("auto"), label: "Auto" }],
      defaultModel: modelRef("auto"),
      thinkingOptions: [],
    });
    const merged = mergeWorkBuddyProductModels(catalog, [
      { id: "auto", name: "Auto" },
      { id: "another-auto", name: " auto " },
      { id: "glm-5.2", name: "GLM-5.2", credits: "x0.79 credits" },
      { id: "glm-5.2-alias", name: "GLM-5.2" },
      { id: "hy3", name: "Hy3", credits: "x0.00 credits" },
    ]);

    expect(merged).toMatchObject({
      defaultModel: modelRef("auto"),
      models: [
        { ref: modelRef("auto"), label: "Auto" },
        { ref: modelRef("glm-5.2"), label: "GLM-5.2 · 0.79x" },
        { ref: modelRef("hy3"), label: "Hy3 · 0.00x" },
      ],
    });
  });
});
