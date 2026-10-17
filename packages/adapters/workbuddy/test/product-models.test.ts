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

  // Windows runners cannot produce a chmod-tight file (chmod is a no-op there),
  // so the POSIX permission assertions only hold on real POSIX filesystems.
  // Same split as history-derivation.test.ts.
  it.runIf(process.platform !== "win32")(
    "falls back to the desktop app's cached product config when no env or bundle file exists",
    async () => {
      const { appCacheProductPath } = await import("../src/product-models.js");
      const { mkdtemp, mkdir, writeFile, chmod, symlink, rm } = await import("node:fs/promises");
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

      const environment = { HOME: home };
      // A tight snapshot in a tight config root resolves.
      expect(await appCacheProductPath(environment, "darwin")).toBe(snapshot);
      expect(await appCacheProductPath(environment, "linux")).toBeUndefined();

      // World-readable snapshot: same rejection rule as the invocation-side loader.
      await chmod(snapshot, 0o644);
      expect(await appCacheProductPath(environment, "darwin")).toBeUndefined();
      await chmod(snapshot, 0o600);

      // A symlinked snapshot (or symlinked config root) is never followed.
      const elsewhere = path.join(home, "elsewhere.json");
      await writeFile(elsewhere, "clone", { mode: 0o600 });
      await rm(snapshot);
      await symlink(elsewhere, snapshot);
      expect(await appCacheProductPath(environment, "darwin")).toBeUndefined();

      // Missing files are not an error — just no fallback.
      await rm(snapshot);
      expect(await appCacheProductPath(environment, "darwin")).toBeUndefined();
    },
  );

  it("ignores the app cache outside darwin and win32 regardless of file state", async () => {
    const { appCacheProductPath } = await import("../src/product-models.js");
    // Platform gate is pure logic — safe to assert on every runner.
    expect(await appCacheProductPath({ HOME: "/nonexistent/nothing" }, "linux")).toBeUndefined();
  });
});
