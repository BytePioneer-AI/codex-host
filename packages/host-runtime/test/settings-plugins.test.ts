import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SETTINGS_PLUGIN_HTML_MAX_BYTES } from "@codexhost/shared-contracts";
import { SettingsPlugins } from "../src/settings-plugins.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const data = await mkdtemp(path.join(os.tmpdir(), "settings-plugins-test-"));
  directories.push(data);
  const root = path.join(data, "settings-plugins");
  await cp(path.resolve(import.meta.dirname, "../../../examples/settings-plugins"), root, {
    recursive: true,
  });
  return { data, root, plugins: new SettingsPlugins({ CODEXHOST_DATA_DIR: data }) };
}
it("discovers only enabled local plugins, lazily reads the declared page and revokes disabled access", async () => {
  const { root, plugins } = await fixture();
  expect(await plugins.list()).toEqual({
    pages: [{ pluginId: "example-page", id: "overview", title: "Example page", icon: "🧩" }],
    unavailable: [],
  });
  expect((await plugins.read({ pluginId: "example-page", pageId: "overview" })).html).toContain(
    "Increase count",
  );
  await expect(plugins.read({ pluginId: "example-page", pageId: "unknown" })).rejects.toThrow();
  await writeFile(path.join(root, "enabled.json"), JSON.stringify({ version: 1, enabled: [] }));
  expect((await plugins.list()).pages).toEqual([]);
  await expect(plugins.read({ pluginId: "example-page", pageId: "overview" })).rejects.toThrow(
    "disabled",
  );
});
it("isolates malformed or missing manifests and fails safely on corrupt enablement configuration", async () => {
  const { root, plugins } = await fixture();
  await writeFile(
    path.join(root, "enabled.json"),
    JSON.stringify({ version: 1, enabled: ["example-page", "missing"] }),
  );
  expect(await plugins.list()).toMatchObject({ unavailable: ["missing"] });
  const manifest = path.join(root, "example-page/manifest.json");
  await writeFile(manifest, "{}");
  expect(await plugins.list()).toEqual({ pages: [], unavailable: ["example-page", "missing"] });
  await writeFile(path.join(root, "enabled.json"), "{broken");
  await expect(plugins.list()).rejects.toThrow("configuration");
  expect(await readFile(path.join(root, "enabled.json"), "utf8")).toBe("{broken");
});
it("does not create a default installation and bounds page resources", async () => {
  const { data, root, plugins } = await fixture();
  expect(
    await new SettingsPlugins({ CODEXHOST_DATA_DIR: path.join(data, "absent") }).list(),
  ).toEqual({ pages: [], unavailable: [] });
  await writeFile(
    path.join(root, "example-page/index.html"),
    "x".repeat(SETTINGS_PLUGIN_HTML_MAX_BYTES + 1),
  );
  await expect(plugins.read({ pluginId: "example-page", pageId: "overview" })).rejects.toThrow(
    "limit",
  );
});
it.skipIf(process.platform === "win32")(
  "rejects resource and plugin-directory symlinks escaping their ownership roots",
  async () => {
    const { data, root, plugins } = await fixture();
    const outside = path.join(data, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.html"), "PRIVATE");
    await rm(path.join(root, "example-page/index.html"));
    await symlink(path.join(outside, "secret.html"), path.join(root, "example-page/index.html"));
    await expect(plugins.read({ pluginId: "example-page", pageId: "overview" })).rejects.toThrow(
      "root",
    );
    await cp(path.join(root, "example-page/manifest.json"), path.join(outside, "manifest.json"));
    await rm(path.join(root, "example-page"), { recursive: true, force: true });
    await symlink(outside, path.join(root, "example-page"));
    expect(await plugins.list()).toEqual({ pages: [], unavailable: ["example-page"] });
  },
);
