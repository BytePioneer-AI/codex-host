import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import {
  harnessPluginDescriptorSchema,
  harnessPluginManifestSchema,
} from "@codexhost/shared-contracts";

import { loadHarnessPlugins, type HarnessPluginDiagnostic } from "../src/harness-plugin-loader.js";
import { HarnessPluginRegistry } from "../src/harness-plugin-registry.js";
import { installedHarnessPluginOptions } from "../src/installed-harness-plugins.js";
import { pluginResourcePath, readPluginIcon } from "../src/plugin-files.js";

const roots: string[] = [];
const context = {
  environment: { PRIVATE_VALUE: "never-report-this" },
  platform: "linux",
  managedRemoteHost: false,
};
const fakeModule = pathToFileURL(path.resolve("packages/harness-adapter/dist/testing.js")).href;

async function root(enabled: string[] = []): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "codexhost-plugins-"));
  roots.push(directory);
  await writeFile(path.join(directory, "enabled.json"), JSON.stringify({ version: 1, enabled }));
  return directory;
}

async function plugin(
  directory: string,
  id: string,
  options: {
    directoryName?: string;
    manifest?: Record<string, unknown>;
    code?: string;
  } = {},
): Promise<string> {
  const location = path.join(directory, options.directoryName ?? id);
  await mkdir(location);
  await writeFile(
    path.join(location, "manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      id,
      name: `Plugin ${id}`,
      version: "1.0.0",
      adapterApiVersion: 1,
      entry: "index.mjs",
      ...options.manifest,
    }),
  );
  await writeFile(
    path.join(location, "index.mjs"),
    options.code ??
      `
    import { FakeHarnessAdapter } from ${JSON.stringify(fakeModule)};
    export function createHarnessAdapter() { return new FakeHarnessAdapter(${JSON.stringify(id)}); }
  `,
  );
  return location;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Harness plugin discovery and loading", () => {
  it.each(["pi", "claude-code", "deepseek-harness", "opencode", "grok", "omp", "antigravity"])(
    "ships a valid %s manifest and resolvable compiled resources",
    async (id) => {
      const location = path.resolve("packages/adapters", id);
      const manifest = harnessPluginManifestSchema.parse(
        JSON.parse(await readFile(path.join(location, "manifest.json"), "utf8")),
      );
      expect(manifest.id).toBe(id);
      await expect(pluginResourcePath(location, manifest.entry)).resolves.toMatch(/\.js$/u);
      if (manifest.icon)
        await expect(readPluginIcon(location, manifest.icon)).resolves.toMatch(/^data:image\//u);
    },
  );

  it("invokes optional plugin warmup without blocking loading and can request cold instances", async () => {
    const directory = await root(["sample-agent"]);
    const location = await plugin(directory, "sample-agent", {
      code: `
      import { writeFileSync } from "node:fs";
      import { FakeHarnessAdapter } from ${JSON.stringify(fakeModule)};
      export function createHarnessAdapter() { return new FakeHarnessAdapter("sample-agent"); }
      export async function warmup() {
        writeFileSync(new URL("warmed", import.meta.url), "yes");
        await new Promise(() => {});
      }
    `,
    });
    const registry = await loadHarnessPlugins({ roots: [directory], context });
    expect(await readFile(path.join(location, "warmed"), "utf8")).toBe("yes");
    await registry.close();
    await rm(path.join(location, "warmed"));
    const cold = await loadHarnessPlugins({ roots: [directory], context, warmup: false });
    await expect(readFile(path.join(location, "warmed"))).rejects.toMatchObject({ code: "ENOENT" });
    await cold.close();
  });

  it("isolates warmup failures and loads only the selected plugin for dedicated runtimes", async () => {
    const directory = await root(["selected", "other"]);
    await plugin(directory, "selected", {
      code: `
      import { FakeHarnessAdapter } from ${JSON.stringify(fakeModule)};
      export function createHarnessAdapter() { return new FakeHarnessAdapter("selected"); }
      export async function warmup() { throw new Error("never-report-this"); }
    `,
    });
    await plugin(directory, "other", { code: 'throw new Error("must not import")' });
    const diagnose = vi.fn();
    const registry = await loadHarnessPlugins({
      roots: [directory],
      context,
      onlyIds: new Set(["selected"]),
      diagnose,
    });
    expect(registry.list().map(({ id }) => id)).toEqual(["selected"]);
    expect(await [...registry.adapters.values()][0]?.inspect()).toMatchObject({ status: "ready" });
    expect(diagnose).toHaveBeenCalledExactlyOnceWith({ id: "selected", code: "warmupFailed" });
    await registry.close();
  });

  it("loads an unknown identity and clones public descriptors", async () => {
    const directory = await root(["sample-agent"]);
    const location = await plugin(directory, "sample-agent", { manifest: { icon: "icon.svg" } });
    await writeFile(
      path.join(location, "icon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h4v4z"/></svg>',
    );
    const registry = await loadHarnessPlugins({ roots: [directory], context });
    expect([...registry.adapters.keys()]).toEqual(["sample-agent"]);
    expect(registry.list()).toEqual([
      expect.objectContaining({
        id: "sample-agent",
        name: "Plugin sample-agent",
        icon: expect.stringMatching(/^data:image\/svg\+xml;base64,/u),
      }),
    ]);
    const first = registry.list()[0];
    if (!first) throw new Error("Expected loaded plugin descriptor");
    first.name = "mutated";
    expect(registry.list()[0]?.name).toBe("Plugin sample-agent");
    const adapter = [...registry.adapters.values()][0];
    if (!adapter) throw new Error("Expected loaded Adapter");
    expect((await adapter.inspect()).status).toBe("ready");
    const close = vi.spyOn(adapter, "close");
    await Promise.all([registry.close(), registry.close()]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not execute an unenabled module or a project-relative root", async () => {
    const directory = await root();
    const location = await plugin(directory, "sample-agent", {
      code: `
      import { writeFileSync } from "node:fs";
      writeFileSync(new URL("executed", import.meta.url), "yes");
      throw new Error("never-report-this");
    `,
    });
    const diagnose = vi.fn();
    const registry = await loadHarnessPlugins({ roots: [directory, "."], context, diagnose });
    expect(registry.list()).toEqual([]);
    await expect(readFile(path.join(location, "executed"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(diagnose).toHaveBeenCalledExactlyOnceWith({ code: "invalidRoot" });
  });

  it("requires a valid explicit enablement configuration", async () => {
    const directory = await root(["sample-agent"]);
    await plugin(directory, "sample-agent");
    await writeFile(
      path.join(directory, "enabled.json"),
      '{"version":1,"enabled":["sample-agent","sample-agent"]}',
    );
    const diagnose = vi.fn();
    expect((await loadHarnessPlugins({ roots: [directory], context, diagnose })).list()).toEqual(
      [],
    );
    expect(diagnose).toHaveBeenCalledExactlyOnceWith({ code: "invalidConfiguration" });
    await rm(path.join(directory, "enabled.json"));
    diagnose.mockClear();
    expect((await loadHarnessPlugins({ roots: [directory], context, diagnose })).list()).toEqual(
      [],
    );
    expect(diagnose).not.toHaveBeenCalled();
  });

  it("rejects duplicate identities across roots before executing either module", async () => {
    const a = await root(["duplicate"]);
    const b = await root();
    await plugin(a, "duplicate", { code: 'throw new Error("must not execute")' });
    await plugin(b, "duplicate", { code: 'throw new Error("must not execute")' });
    const diagnose = vi.fn();
    const registry = await loadHarnessPlugins({ roots: [a, b], context, diagnose });
    expect(registry.list()).toEqual([]);
    expect(diagnose).toHaveBeenCalledExactlyOnceWith({ id: "duplicate", code: "duplicateId" });
  });

  it("does not shadow a transitional built-in and rejects the official identity", async () => {
    const directory = await root(["sample-agent"]);
    await plugin(directory, "sample-agent");
    await plugin(directory, "codex");
    const diagnose = vi.fn();
    const registry = await loadHarnessPlugins({
      roots: [directory],
      context,
      reservedIds: new Set(["sample-agent"]),
      diagnose,
    });
    expect(registry.list()).toEqual([]);
    expect(diagnose.mock.calls.map(([entry]) => entry.code)).toEqual([
      "invalidManifest",
      "duplicateId",
    ]);
  });

  it("keeps an incompatible plugin visible but never imports its entry", async () => {
    const directory = await root(["future-agent"]);
    await plugin(directory, "future-agent", {
      manifest: { adapterApiVersion: 2 },
      code: 'throw new Error("never-report-this")',
    });
    const diagnose = vi.fn();
    const registry = await loadHarnessPlugins({ roots: [directory], context, diagnose });
    expect(registry.list()[0]?.id).toBe("future-agent");
    const adapter = [...registry.adapters.values()][0];
    expect(await adapter?.inspect()).toMatchObject({
      status: "unavailable",
      error: { stage: "pluginLoad", retryable: false },
    });
    expect(diagnose).toHaveBeenCalledExactlyOnceWith({
      id: "future-agent",
      code: "incompatibleVersion",
    });
    await registry.close();
  });

  it.each(["manifest.json", "index.mjs", "icon.svg"])(
    "rejects an escaping %s symlink",
    async (resource) => {
      const directory = await root(["sample-agent"]);
      const outside = await root();
      const location = await plugin(directory, "sample-agent", {
        manifest: resource === "icon.svg" ? { icon: resource } : {},
      });
      const external = path.join(outside, resource);
      await writeFile(
        external,
        resource === "manifest.json"
          ? await readFile(path.join(location, resource))
          : "not executed",
      );
      await rm(path.join(location, resource), { force: true });
      await symlink(external, path.join(location, resource));
      const diagnose = vi.fn();
      const registry = await loadHarnessPlugins({ roots: [directory], context, diagnose });
      if (resource === "manifest.json") expect(registry.list()).toEqual([]);
      else
        expect(await [...registry.adapters.values()][0]?.inspect()).toMatchObject({
          status: "unavailable",
        });
      expect(diagnose).toHaveBeenCalledWith(
        expect.objectContaining({
          code: resource === "manifest.json" ? "invalidManifest" : "loadFailed",
        }),
      );
      await registry.close();
    },
  );

  it.each([
    "<script>alert(1)</script>",
    '<path fill="url(https://example.com/paint.svg#gradient)"/>',
  ])("rejects active/external SVG and over-sized manifests, case %#", async (content) => {
    const directory = await root(["sample-agent"]);
    const location = await plugin(directory, "sample-agent", { manifest: { icon: "icon.svg" } });
    await writeFile(
      path.join(location, "icon.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`,
    );
    const diagnose = vi.fn();
    const registry = await loadHarnessPlugins({ roots: [directory], context, diagnose });
    expect(await [...registry.adapters.values()][0]?.inspect()).toMatchObject({
      status: "unavailable",
    });
    await registry.close();
    await writeFile(path.join(location, "manifest.json"), " ".repeat(32 * 1024 + 1));
    expect((await loadHarnessPlugins({ roots: [directory], context, diagnose })).list()).toEqual(
      [],
    );
    expect(diagnose).toHaveBeenCalledWith({ code: "invalidManifest" });
  });

  it("isolates load errors and never publishes plugin error details", async () => {
    const directory = await root(["bad-agent", "good-agent"]);
    await plugin(directory, "bad-agent", {
      code: 'throw new Error("never-report-this /private/credentials")',
    });
    await plugin(directory, "good-agent");
    const diagnostics: HarnessPluginDiagnostic[] = [];
    const registry = await loadHarnessPlugins({
      roots: [directory],
      context,
      diagnose: (entry) => {
        diagnostics.push(entry);
      },
    });
    expect(diagnostics).toEqual([{ id: "bad-agent", code: "loadFailed" }]);
    expect(JSON.stringify(registry.list())).not.toContain("never-report-this");
    expect(await [...registry.adapters.values()][1]?.inspect()).toMatchObject({ status: "ready" });
    await registry.close();
  });

  it("closes invalid factory results and late results after a timeout", async () => {
    const directory = await root(["wrong-agent", "slow-agent", "good-agent"]);
    const wrong = await plugin(directory, "wrong-agent", {
      code: `
      import { writeFileSync } from "node:fs";
      export function createHarnessAdapter() {
        return { harnessId: "someone-else", close() { writeFileSync(new URL("closed", import.meta.url), "yes"); } };
      }
    `,
    });
    const slow = await plugin(directory, "slow-agent", {
      code: `
      import { writeFileSync } from "node:fs";
      import { FakeHarnessAdapter } from ${JSON.stringify(fakeModule)};
      export async function createHarnessAdapter(context) {
        writeFileSync(new URL("started", import.meta.url), String(Object.isFrozen(context.environment)));
        await new Promise(resolve => setTimeout(resolve, 350));
        const adapter = new FakeHarnessAdapter("slow-agent");
        adapter.close = async () => { writeFileSync(new URL("closed", import.meta.url), "yes"); };
        return adapter;
      }
    `,
    });
    await plugin(directory, "good-agent");
    const diagnose = vi.fn();
    const registry = await loadHarnessPlugins({
      roots: [directory],
      context,
      loadTimeoutMs: 200,
      diagnose,
    });
    expect(diagnose).toHaveBeenCalledWith({ id: "slow-agent", code: "loadTimeout" });
    expect(diagnose).toHaveBeenCalledWith({ id: "wrong-agent", code: "loadFailed" });
    expect(await readFile(path.join(wrong, "closed"), "utf8")).toBe("yes");
    expect(await readFile(path.join(slow, "started"), "utf8")).toBe("true");
    await vi.waitFor(async () =>
      expect(await readFile(path.join(slow, "closed"), "utf8")).toBe("yes"),
    );
    await registry.close();
  });
});

describe("Harness plugin registry lifetime", () => {
  it("closes every Adapter even when one close throws synchronously", async () => {
    const registry = new HarnessPluginRegistry();
    const first = harnessPluginDescriptorSchema.parse({ id: "first", name: "First", version: "1" });
    const second = harnessPluginDescriptorSchema.parse({
      id: "second",
      name: "Second",
      version: "1",
    });
    const a = new FakeHarnessAdapter(first.id);
    const b = new FakeHarnessAdapter(second.id);
    const aClose = vi.spyOn(a, "close").mockImplementation(() => {
      throw new Error("failure");
    });
    const bClose = vi.spyOn(b, "close");
    registry.register(first, a);
    registry.register(second, b);
    first.name = "changed";
    expect(registry.list()[0]?.name).toBe("First");
    await expect(registry.close()).rejects.toBeInstanceOf(AggregateError);
    await expect(registry.close()).rejects.toBeInstanceOf(AggregateError);
    expect(aClose).toHaveBeenCalledTimes(1);
    expect(bClose).toHaveBeenCalledTimes(1);
    expect(() => registry.register(first, a)).toThrow("closed");
  });

  it("uses the configured Host data directory and omits a remote URL opener", () => {
    const data = path.resolve("host-data");
    expect(installedHarnessPluginOptions({ CODEXHOST_DATA_DIR: data }, true).pluginRoots[1]).toBe(
      path.join(data, "plugins"),
    );
    expect(installedHarnessPluginOptions({}, true).pluginContext.openLocalUrl).toBeUndefined();
    const custom = path.resolve("custom-plugins");
    expect(
      installedHarnessPluginOptions({ CODEXHOST_PLUGIN_DIRECTORY: custom }).pluginRoots[1],
    ).toBe(custom);
  });
});
