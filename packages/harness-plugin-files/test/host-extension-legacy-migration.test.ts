import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  discoverHostExtensions,
  migrateLegacyDesktopExtensionsOnce,
  readHostExtensionSettings,
} from "../src/index.js";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "legacy-desktop-extensions-"));
});
afterEach(async () => {
  await rm(dataDir, { force: true, recursive: true });
});

const sidebar = "sidebar-thread-tree";
const oldRoot = () => path.join(dataDir, "desktop-extensions");
const newRoot = () => path.join(dataDir, "host-extensions");

async function put(file: string, contents: string) {
  const target = path.join(dataDir, file);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, contents, { mode: 0o600 });
}

async function legacyPackage(id: string, script = "desktop.js") {
  const manifest = {
    id,
    manifestVersion: 1,
    desktopApi: 1,
    name: "Sidebar Thread Tree",
    version: "0.1.0",
    desktop: { script },
  };
  await put(`desktop-extensions/${id}/manifest.json`, JSON.stringify(manifest));
  await put(`desktop-extensions/${id}/desktop.js`, "define({activate(){}})");
}

async function select(...enabled: string[]) {
  await put(
    "desktop-extensions/enabled.json",
    JSON.stringify({
      version: 1,
      revision: 7,
      enabled,
      reloadToken: "d019574b-ba23-4066-bfad-5926889de99a",
    }),
  );
}

it("copies a flat v1 install, preserving selection order, settings and backend data", async () => {
  await legacyPackage(sidebar);
  await legacyPackage("alpha");
  await legacyPackage("disabled");
  await select(sidebar, "missing", "alpha");
  const values = { collapsed: ["thread-1"] };
  const oldSettings = JSON.stringify(values);
  await put(`desktop-extension-data/${sidebar}/settings.json`, oldSettings);
  await put(`desktop-extension-data/${sidebar}/store/state`, "backend data");

  const migrationDiagnostics: string[] = [];
  await migrateLegacyDesktopExtensionsOnce(dataDir, (message) =>
    migrationDiagnostics.push(message),
  );
  const { configuration, extensions, diagnostics } = await discoverHostExtensions(dataDir);
  expect([...migrationDiagnostics, ...diagnostics]).toEqual([]);
  expect(configuration).toEqual({ revision: 7, enabled: [sidebar, "alpha"] });
  expect(extensions).toEqual([
    expect.objectContaining({ id: "alpha", state: "valid", enabled: true }),
    expect.objectContaining({ id: "disabled", state: "valid", enabled: false }),
    expect.objectContaining({
      id: sidebar,
      state: "valid",
      enabled: true,
      manifest: expect.objectContaining({ manifestVersion: 2 }),
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      source: { type: "localDir" },
    }),
  ]);
  expect(await readHostExtensionSettings({ dataDir, id: sidebar })).toEqual({
    settingsRevision: 0,
    values,
  });
  expect(
    await readFile(path.join(dataDir, "host-extension-data", sidebar, "store/state"), "utf8"),
  ).toBe("backend data");
  expect(
    await readFile(path.join(dataDir, "desktop-extension-data", sidebar, "settings.json"), "utf8"),
  ).toBe(oldSettings);
  expect(await readdir(path.join(oldRoot(), sidebar))).toContain("desktop.js");

  await select();
  await migrateLegacyDesktopExtensionsOnce(dataDir);
  expect(await discoverHostExtensions(dataDir)).toMatchObject({ configuration, extensions });
});

it("leaves an existing Host store alone", async () => {
  await legacyPackage(sidebar);
  await select(sidebar);
  const initial = JSON.stringify({ revision: 17, enabled: [] });
  await put("host-extensions/enabled.json", initial);
  await migrateLegacyDesktopExtensionsOnce(dataDir);
  expect(await readFile(path.join(newRoot(), "enabled.json"), "utf8")).toBe(initial);
  expect(await readdir(newRoot())).toEqual(["enabled.json"]);
});

it("does not create the Host store when there is no legacy installation root", async () => {
  await migrateLegacyDesktopExtensionsOnce(dataDir);
  expect(await readdir(dataDir)).toEqual([]);
});

it("keeps existing Host data and skips damaged, linked and escaping legacy entries", async () => {
  await legacyPackage(sidebar);
  await legacyPackage("missing-script", "missing.js");
  await legacyPackage("escaping", "../../outside/desktop.js");
  await legacyPackage("nested-link", "assets/desktop.js");
  await put("desktop-extensions/broken/manifest.json", "not JSON");
  await put("outside/desktop.js", "define({activate(){}})");
  await symlink(path.join(oldRoot(), sidebar), path.join(oldRoot(), "linked"), "junction");
  await symlink(
    path.join(dataDir, "outside"),
    path.join(oldRoot(), "nested-link/assets"),
    "junction",
  );
  await put(`desktop-extension-data/${sidebar}/settings.json`, '{"old":true}');
  await put(
    `host-extension-data/${sidebar}/settings.json`,
    '{"settingsRevision":4,"values":{"new":true}}',
  );
  await legacyPackage("linked-data");
  await put("desktop-extension-data/linked-data/state", "legacy state");
  await symlink(
    path.join(dataDir, "outside"),
    path.join(dataDir, "desktop-extension-data/linked-data/linked"),
    "junction",
  );
  await select("linked", "escaping", "nested-link", "broken", "missing-script", sidebar);

  const diagnostics: string[] = [];
  await migrateLegacyDesktopExtensionsOnce(dataDir, (message) => diagnostics.push(message));
  expect(await discoverHostExtensions(dataDir)).toMatchObject({
    configuration: { enabled: [sidebar] },
    extensions: [
      { id: "linked-data", state: "valid", enabled: false },
      { id: sidebar, state: "valid", enabled: true },
    ],
  });
  expect(diagnostics).toHaveLength(6);
  for (const id of ["linked", "escaping", "nested-link", "broken", "missing-script", "linked-data"])
    expect(diagnostics.some((message) => message.includes(id))).toBe(true);
  expect(await readHostExtensionSettings({ dataDir, id: sidebar })).toEqual({
    settingsRevision: 4,
    values: { new: true },
  });
  expect(await readdir(path.join(dataDir, "host-extension-data"))).toEqual([sidebar]);
});
