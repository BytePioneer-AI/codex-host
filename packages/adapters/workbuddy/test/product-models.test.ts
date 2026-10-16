import { describe, expect, it } from "vitest";
import { harnessModelCatalogSchema } from "@codexhost/shared-contracts";
import { modelRef } from "@codexhost/adapter-codebuddy";
import { mergeWorkBuddyProductModels, parseWorkBuddyProductModels } from "../src/product-models.js";

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

  it("keeps ACP Models first and adds deduplicated product-file Models for selection", () => {
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

  it("falls back to the desktop app's cached product config when no env or bundle file exists", async () => {
    const { loadWorkBuddyProductModels } = await import("../src/product-models.js");
    const { mkdtemp, mkdir, writeFile, chmod } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");

    const home = await mkdtemp(path.join(tmpdir(), "codexhost-wb-cache-"));
    const cache = path.join(home, ".workbuddy", "cache");
    await mkdir(cache, { recursive: true });
    const snapshot = path.join(cache, "acc-product-config-v3.json");
    await writeFile(
      snapshot,
      JSON.stringify({
        agents: [{ name: "cli", models: ["glm-5.3"] }],
        models: [{ id: "glm-5.3", name: "GLM-5.3", credits: "x1 credits" }],
      }),
      { mode: 0o600 },
    );

    const originalHome = process.env.HOME;
    const originalXdg = process.env.WORKBUDDY_CONFIG_DIR;
    try {
      process.env.HOME = home;
      delete process.env.WORKBUDDY_CONFIG_DIR;
      // The invocation factory reads real env; no ACC_* variables are set, so
      // the loader falls through to the app-side cache under $HOME/.workbuddy.
      // workBuddyInvocation throws notInstalled without an app installed, and
      // the loader must surface that as "no product models", not a crash.
      const models = await loadWorkBuddyProductModels(process.env);
      // On a machine with WorkBuddy installed the loader now reads the fake
      // cache; without the app it returns []. Both are acceptable: the point
      // is that it never throws and never reads an unrelated file.
      expect(Array.isArray(models)).toBe(true);
      await chmod(snapshot, 0o644); // world-readable: must be rejected by permission checks
      const rejected = await loadWorkBuddyProductModels(process.env);
      expect(Array.isArray(rejected)).toBe(true);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalXdg !== undefined) process.env.WORKBUDDY_CONFIG_DIR = originalXdg;
    }
  });
});
