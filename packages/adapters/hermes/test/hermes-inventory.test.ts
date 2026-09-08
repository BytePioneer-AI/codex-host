import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  catalogModelsFromInventory,
  inventoryPythonCandidates,
  readHermesModelInventory,
} from "../src/hermes-inventory.js";
import { encodeHermesModelRef, projectHermesModelState } from "../src/hermes-models.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Hermes model catalog", () => {
  it("labels each model as Provider / model", () => {
    const catalog = catalogModelsFromInventory({
      models: [
        { modelId: "zai:glm-5-turbo", label: "glm-5-turbo", provider: "Z.AI" },
        {
          modelId: "minimax-oauth:MiniMax-M3",
          label: "MiniMax-M3",
          provider: "MiniMax",
        },
      ],
      currentModelId: "zai:glm-5-turbo",
    });

    expect(catalog.models.map(({ label }) => label)).toEqual([
      "Z.AI / glm-5-turbo",
      "MiniMax / MiniMax-M3",
    ]);
    expect(catalog.defaultModel).not.toBeNull();
  });

  it("does not invent a default when Hermes reports no configured model", () => {
    const catalog = catalogModelsFromInventory({
      models: [{ modelId: "zai:glm-5-turbo", label: "glm-5-turbo", provider: "Z.AI" }],
      currentModelId: null,
    });

    expect(catalog.defaultModel).toBeNull();
  });

  it("hides a virtual MoA preset whose backing providers are unavailable", () => {
    const catalog = catalogModelsFromInventory({
      models: [
        {
          modelId: "moa:default",
          label: "default",
          provider: "Mixture of Agents",
          available: false,
        },
        { modelId: "zai:glm-5-turbo", label: "glm-5-turbo", provider: "Z.AI" },
      ],
      currentModelId: "zai:glm-5-turbo",
    });

    expect(catalog.models.map(({ label }) => label)).toEqual(["Z.AI / glm-5-turbo"]);
  });
});

describe("Hermes inventory process", () => {
  it("resolves the interpreter next to the official Windows launcher", () => {
    expect(
      inventoryPythonCandidates(
        "C:\\Users\\test\\.hermes\\hermes-agent\\venv\\Scripts\\hermes.exe",
        "win32",
      )[0],
    ).toBe("C:\\Users\\test\\.hermes\\hermes-agent\\venv\\Scripts\\python.exe");
  });

  it("passes the Adapter environment to the inventory subprocess", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-inventory-env-"));
    temporaryDirectories.push(directory);
    const binDirectory = path.join(directory, "venv", "bin");
    await mkdir(binDirectory, { recursive: true });
    const launcher = path.join(binDirectory, "hermes");
    const python = path.join(binDirectory, "python");
    await writeFile(launcher, "#!/bin/sh\nexit 0\n");
    await writeFile(
      python,
      `#!/usr/bin/env node
if (process.env.HERMES_TEST_INVENTORY !== "visible") process.exit(4);
console.log(JSON.stringify({ models: [], currentModelId: null }));
`,
    );
    await chmod(launcher, 0o755);
    await chmod(python, 0o755);

    await expect(
      readHermesModelInventory(launcher, 10_000, {
        environment: { ...process.env, HERMES_TEST_INVENTORY: "visible" },
      }),
    ).resolves.toEqual({ models: [], currentModelId: null });
  });

  it("isolates imports from an untrusted launch directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-inventory-isolation-"));
    temporaryDirectories.push(directory);
    const hostileDirectory = path.join(directory, "hostile-checkout");
    const binDirectory = path.join(directory, "venv", "bin");
    await mkdir(hostileDirectory, { recursive: true });
    await mkdir(binDirectory, { recursive: true });
    const launcher = path.join(binDirectory, "hermes");
    const python = path.join(binDirectory, "python");
    await writeFile(launcher, "#!/bin/sh\nexit 0\n");
    await writeFile(
      python,
      `#!/usr/bin/env node
if (!process.argv.includes("-I")) process.exit(5);
if (process.cwd() === process.env.HERMES_TEST_HOSTILE_CWD) process.exit(6);
console.log(JSON.stringify({ models: [], currentModelId: null }));
`,
    );
    await chmod(launcher, 0o755);
    await chmod(python, 0o755);
    const previousCwd = process.cwd();

    try {
      process.chdir(hostileDirectory);
      await expect(
        readHermesModelInventory(launcher, 10_000, {
          environment: { ...process.env, HERMES_TEST_HOSTILE_CWD: hostileDirectory },
        }),
      ).resolves.toEqual({ models: [], currentModelId: null });
    } finally {
      process.chdir(previousCwd);
    }
  });
});

describe("Hermes Session Model projection", () => {
  it.each([undefined, "unknown:model"])(
    "does not invent an effective Model for currentModelId=%s",
    (currentModelId) => {
      expect(
        projectHermesModelState({
          availableModels: [{ modelId: "zai:glm-5-turbo", name: "GLM 5 Turbo" }],
          ...(currentModelId ? { currentModelId } : {}),
        }),
      ).toEqual({ effectiveModel: null, resolvedModelLabel: null });
    },
  );

  it("aligns the native provider separator with the inventory catalog label", () => {
    expect(
      projectHermesModelState({
        availableModels: [{ modelId: "zai:glm-5.3", name: "Z.AI · GLM · glm-5.3" }],
        currentModelId: "zai:glm-5.3",
      }),
    ).toEqual({
      effectiveModel: encodeHermesModelRef("zai:glm-5.3"),
      resolvedModelLabel: "Z.AI / GLM / glm-5.3",
    });
  });
});
