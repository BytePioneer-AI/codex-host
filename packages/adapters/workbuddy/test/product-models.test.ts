import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { harnessModelCatalogSchema } from "@codexhost/shared-contracts";
import { modelRef } from "@codexhost/adapter-codebuddy";
import * as command from "../src/command.js";
import {
  loadWorkBuddyProductModels,
  mergeWorkBuddyProductModels,
  parseWorkBuddyProductModels,
} from "../src/product-models.js";

describe("WorkBuddy product Model metadata", () => {
  it("loads bundled product models with credential preload arguments", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wb-product-models-"));
    try {
      const app = path.join(root, "WorkBuddy AI.app");
      const platform = process.platform === "win32" ? "win32" : "darwin";
      const resources = platform === "win32" ? ["resources"] : ["Contents", "Resources"];
      const pkg = path.join(app, ...resources, "app.asar.unpacked", "cli");
      const cli = path.join(pkg, "bin", "codebuddy");
      await mkdir(path.dirname(cli), { recursive: true });
      await writeFile(cli, "");
      await writeFile(
        path.join(pkg, "product.json"),
        JSON.stringify({
          dataFolderName: ".workbuddy-ai",
          agents: [{ name: "cli", models: ["glm-5.2"] }],
          models: [{ id: "glm-5.2", name: "GLM-5.2" }],
        }),
      );
      const environment = { HOME: root, CODEXHOST_WORKBUDDY_COMMAND: app };
      const invocation = command.workBuddyInvocation(environment, true, {
        platform,
        isExecutable: () => true,
      });
      expect(invocation.arguments).toEqual([
        "--eval",
        expect.any(String),
        cli,
        "--acp",
        "--no-session-persistence",
      ]);
      expect(invocation.environment.ACC_PRODUCT_CONFIG_PATH).toBeUndefined();
      vi.spyOn(command, "workBuddyInvocation").mockReturnValue(invocation);
      expect(await loadWorkBuddyProductModels(environment)).toEqual([
        { id: "glm-5.2", name: "GLM-5.2" },
      ]);
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });

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
});
