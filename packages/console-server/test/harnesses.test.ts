import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConsoleHarnesses, harnessPluginRoots } from "../src/harnesses.js";

let root: string;

async function plugin(pluginsRoot: string, id: string, launchCommand: boolean): Promise<void> {
  await mkdir(path.join(pluginsRoot, id), { recursive: true });
  await writeFile(
    path.join(pluginsRoot, id, "manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      id,
      name: id.toUpperCase(),
      version: "1.0.0",
      ...(launchCommand ? { launchCommand: true } : {}),
      adapterApiVersion: 1,
      entry: "plugin.mjs",
    }),
  );
  // Never imported by the console.
  await writeFile(path.join(pluginsRoot, id, "plugin.mjs"), "throw new Error('imported');\n");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codexhost-console-harnesses-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("console Harnesses", () => {
  it("uses the Host Runtime's plugin roots", () => {
    expect(
      harnessPluginRoots("/opt/codexhost/app", false, { CODEXHOST_DATA_DIR: "/data" }),
    ).toEqual([path.join("/opt/codexhost/app", "plugins"), path.join("/data", "plugins")]);
    expect(
      harnessPluginRoots("/repo/packages/console-server/dist", true, {
        CODEXHOST_PLUGIN_DIRECTORY: "/custom",
      }),
    ).toEqual([path.resolve("/repo/packages/host-runtime/dist/plugins"), "/custom"]);
  });

  it("lists manifests without importing plugin code and writes shared launch settings", async () => {
    const pluginsRoot = path.join(root, "plugins");
    await plugin(pluginsRoot, "pi", true);
    await plugin(pluginsRoot, "grok", false);
    await writeFile(
      path.join(pluginsRoot, "enabled.json"),
      JSON.stringify({ version: 1, enabled: ["pi"] }),
    );
    const environment = { CODEXHOST_DATA_DIR: path.join(root, "data") };
    const harnesses = createConsoleHarnesses([pluginsRoot], environment);

    const listed = await harnesses.list();
    expect(listed.map((harness) => [harness.id, harness.enabled, harness.launchCommand])).toEqual([
      ["pi", true, true],
      ["grok", false, false],
    ]);

    const installation = path.join(root, "pi-install");
    await mkdir(installation);
    await expect(harnesses.setLaunchPath("pi", installation)).resolves.toMatchObject({
      launchPath: installation,
    });
    expect(
      JSON.parse(
        await readFile(path.join(root, "data", "harness-launch-settings", "pi.json"), "utf8"),
      ),
    ).toBe(installation);
    await expect(harnesses.setLaunchPath("grok", installation)).rejects.toMatchObject({
      status: 400,
    });
    await expect(harnesses.setLaunchPath("missing", null)).rejects.toMatchObject({ status: 404 });
    await expect(harnesses.setLaunchPath("pi", path.join(root, "nope"))).rejects.toMatchObject({
      status: 400,
    });
  });
});
