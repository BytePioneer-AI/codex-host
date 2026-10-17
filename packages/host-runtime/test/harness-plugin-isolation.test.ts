import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { discoverHarnessPlugins } from "@codexhost/harness-plugin-files";
import { harnessPluginDescriptorSchema } from "@codexhost/shared-contracts";

import { loadHarnessPlugins } from "../src/harness-plugin-loader.js";
import { HarnessPluginRegistry } from "../src/harness-plugin-registry.js";

const roots: string[] = [];
const context = { environment: {}, platform: "linux", managedRemoteHost: false };
const fakeModule = pathToFileURL(path.resolve("packages/harness-adapter/dist/testing.js")).href;

async function plugins(enabled = ["codex", "external-agent", "codex-usage"]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "codexhost-plugin-scope-"));
  roots.push(root);
  await writeFile(path.join(root, "enabled.json"), JSON.stringify({ version: 1, enabled }));
  for (const id of ["codex", "external-agent", "codex-usage"]) {
    const directory = path.join(root, id);
    await mkdir(directory);
    await writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        id,
        name: id,
        version: "1.0.0",
        adapterApiVersion: 1,
        entry: "plugin.mjs",
        ...(id === "codex-usage" ? { kind: "usage" } : {}),
      }),
    );
    await writeFile(
      path.join(directory, "plugin.mjs"),
      `import { writeFileSync } from "node:fs";
       import { FakeHarnessAdapter } from ${JSON.stringify(fakeModule)};
       const mark = (step) => writeFileSync(new URL(step, import.meta.url), "yes");
       mark("imported");
       export function createHarnessAdapter() {
         mark("created");
         const adapter = new FakeHarnessAdapter(${JSON.stringify(id)});
         adapter.close = async () => { mark("closed"); };
         return adapter;
       }
       export function createUsageStatisticsAdapter() {
         mark("created");
         return { harnessId: ${JSON.stringify(id)}, close: async () => mark("closed"),
           usageStatistics: { listSources: async () => [], readSource: async () => [] } };
       }
       export async function warmup() { mark("warmed"); }`,
    );
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("discovers Codex and usage metadata without executing either plugin", async () => {
  const root = await plugins();
  const diagnose = vi.fn();
  const result = await discoverHarnessPlugins([root], diagnose);
  expect(result.plugins.map(({ manifest }) => manifest.id).sort()).toEqual([
    "codex",
    "codex-usage",
    "external-agent",
  ]);
  expect(result.plugins.every(({ enabled }) => enabled)).toBe(true);
  expect(diagnose).not.toHaveBeenCalled();
  for (const { root: directory } of result.plugins)
    expect(existsSync(path.join(directory, "imported"))).toBe(false);
});

it.each([undefined, "external"] as const)(
  "excludes enabled Codex before import, factory and warmup in scope %s",
  async (scope) => {
    const root = await plugins();
    const diagnose = vi.fn();
    const registry = await loadHarnessPlugins({
      roots: [root],
      context,
      ...(scope ? { scope } : {}),
      diagnose,
    });
    try {
      expect([...registry.adapters.keys()]).toEqual(["external-agent"]);
      expect([...registry.usageAdapters.keys()]).toEqual(["codex-usage"]);
      expect(
        registry
          .list()
          .map(({ id }) => id)
          .sort(),
      ).toEqual(["codex-usage", "external-agent"]);
      for (const step of ["imported", "created", "warmed"])
        expect(existsSync(path.join(root, "codex", step))).toBe(false);
      expect(diagnose).not.toHaveBeenCalled();
    } finally {
      await registry.close();
    }
  },
);

it("does not let onlyIds widen the external runtime scope", async () => {
  const root = await plugins();
  const registry = await loadHarnessPlugins({
    roots: [root],
    context,
    onlyIds: new Set(["codex"]),
  });
  expect(registry.list()).toEqual([]);
  expect(existsSync(path.join(root, "codex", "imported"))).toBe(false);
  await registry.close();
});

it("requires explicit enablement even for the Web Codex runtime", async () => {
  const root = await plugins(["external-agent"]);
  const registry = await loadHarnessPlugins({ roots: [root], context, scope: "web-codex" });
  expect(registry.list()).toEqual([]);
  expect(existsSync(path.join(root, "codex", "imported"))).toBe(false);
  await registry.close();
});

it("loads and closes Web Codex independently from external and usage adapters", async () => {
  const root = await plugins();
  const web = await loadHarnessPlugins({ roots: [root], context, scope: "web-codex" });
  expect([...web.adapters.keys()]).toEqual(["codex"]);
  expect(web.usageAdapters.size).toBe(0);
  for (const id of ["external-agent", "codex-usage"])
    expect(existsSync(path.join(root, id, "imported"))).toBe(false);
  for (const step of ["imported", "created", "warmed"])
    expect(await readFile(path.join(root, "codex", step), "utf8")).toBe("yes");

  const external = await loadHarnessPlugins({ roots: [root], context });
  try {
    await web.close();
    expect(existsSync(path.join(root, "codex", "closed"))).toBe(true);
    expect(existsSync(path.join(root, "external-agent", "closed"))).toBe(false);
    expect(existsSync(path.join(root, "codex-usage", "closed"))).toBe(false);
    expect(await [...external.adapters.values()][0]?.inspect()).toMatchObject({ status: "ready" });
  } finally {
    await web.close();
    await external.close();
  }
});

it("refuses direct Codex registration in an external registry", async () => {
  const registry = new HarnessPluginRegistry();
  const descriptor = harnessPluginDescriptorSchema.parse({
    id: "codex",
    name: "Codex",
    version: "1",
  });
  const adapter = new FakeHarnessAdapter(descriptor.id);
  expect(() => registry.register(descriptor, adapter)).toThrow("outside this runtime's scope");
  expect(registry.list()).toEqual([]);
  await registry.close();
  await adapter.close();
});
