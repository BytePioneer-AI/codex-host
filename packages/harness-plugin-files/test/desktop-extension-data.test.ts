import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DESKTOP_EXTENSION_ASSET_MAX_BYTES,
  DESKTOP_EXTENSION_SCRIPT_MAX_BYTES,
  DESKTOP_EXTENSION_SETTINGS_MAX_BYTES,
} from "@codexhost/shared-contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { extensionZip } from "../../../tests/fixtures/desktop-extension-zip.js";
import {
  desktopExtensionsRoot,
  discoverDesktopExtensions,
  installFromZipBuffer,
  readDesktopExtensionAsset,
  readDesktopExtensionSettings,
  uninstallDesktopExtension,
  writeDesktopExtensionSettings,
} from "../src/index.js";

const id = "sample";
let dataDir: string;
let directory: string;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "desktop-extension-data-"));
  directory = path.join(desktopExtensionsRoot(dataDir), id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

it("returns MIME and base64 bytes for PNG and JSON assets", async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await mkdir(path.join(directory, "assets"));
  await writeFile(path.join(directory, "assets", "paper.PNG"), png);
  await writeFile(path.join(directory, "colors.json"), '{"primary":"blue"}');
  const asset = (assetPath: string) => readDesktopExtensionAsset({ dataDir, id, assetPath });
  expect(await asset("assets/paper.PNG")).toEqual({
    mimeType: "image/png",
    dataUrl: `data:image/png;base64,${png.toString("base64")}`,
  });
  expect(await asset("colors.json")).toEqual({
    mimeType: "application/json",
    dataUrl: `data:application/json;base64,${Buffer.from('{"primary":"blue"}').toString("base64")}`,
  });
});

it("rejects traversal, absolute paths, unsupported extensions and oversized assets", async () => {
  await writeFile(path.join(directory, "big.css"), "");
  await truncate(path.join(directory, "big.css"), DESKTOP_EXTENSION_ASSET_MAX_BYTES + 1);
  for (const assetPath of [
    "../secret.json",
    "foo/../big.css",
    "C:\\config.json",
    path.join(dataDir, "file.json"),
    "script.js",
  ]) {
    await expect(readDesktopExtensionAsset({ dataDir, id, assetPath })).rejects.toThrow();
  }
  await expect(
    readDesktopExtensionAsset({ dataDir, id: "../sample", assetPath: "big.css" }),
  ).rejects.toThrow();
  await expect(readDesktopExtensionAsset({ dataDir, id, assetPath: "big.css" })).rejects.toThrow(
    "exceeds its limit",
  );
});

it("rejects symlink escapes from assets, extension data and backend entries", async () => {
  const outside = path.join(dataDir, "escaped.json");
  await writeFile(outside, '{"outside":true}');
  await symlink(outside, path.join(directory, "link.json"));
  await symlink(dataDir, path.join(desktopExtensionsRoot(dataDir), "linked"), "junction");
  await expect(readDesktopExtensionAsset({ dataDir, id, assetPath: "link.json" })).rejects.toThrow(
    "inside its root",
  );
  await expect(
    readDesktopExtensionAsset({ dataDir, id: "linked", assetPath: "escaped.json" }),
  ).rejects.toThrow("regular directory");
  await mkdir(path.join(dataDir, "desktop-extension-data"));
  await symlink(dataDir, path.join(dataDir, "desktop-extension-data", id), "junction");
  await expect(writeDesktopExtensionSettings({ dataDir, id, values: {} })).rejects.toThrow(
    "regular directory",
  );
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      desktopApi: 1,
      id,
      name: "Sample",
      version: "1",
      backend: { script: "link.json" },
    }),
  );
  expect(
    (await discoverDesktopExtensions(desktopExtensionsRoot(dataDir))).extensions,
  ).toContainEqual({ id, state: "invalid", error: expect.stringContaining("inside its root") });
});

it("atomically replaces only that extension's settings and retains them across updates and uninstall", async () => {
  const location = { dataDir, id };
  expect(await readDesktopExtensionSettings(location)).toEqual({});
  const first = { old: true, nested: [1] };
  const last = { blur: 4 };
  expect(await writeDesktopExtensionSettings({ ...location, values: first })).toEqual(first);
  const [concurrentRead] = await Promise.all([
    readDesktopExtensionSettings(location),
    writeDesktopExtensionSettings({ ...location, values: last }),
  ]);
  expect([first, last]).toContainEqual(concurrentRead);
  const settings = path.join(dataDir, "desktop-extension-data", id);
  expect(await readdir(settings)).toEqual(["settings.json"]);
  expect(JSON.parse(await readFile(path.join(settings, "settings.json"), "utf8"))).toEqual(last);
  await expect(writeDesktopExtensionSettings({ ...location, values: [] })).rejects.toThrow();
  await expect(
    writeDesktopExtensionSettings({
      ...location,
      values: { huge: "é".repeat(DESKTOP_EXTENSION_SETTINGS_MAX_BYTES / 2) },
    }),
  ).rejects.toThrow("1 MiB");
  await installFromZipBuffer({
    extensionsRoot: desktopExtensionsRoot(dataDir),
    zipBuffer: extensionZip(),
  });
  expect(await readDesktopExtensionSettings(location)).toEqual(last);
  expect(await readDesktopExtensionSettings({ dataDir, id: "another" })).toEqual({});
  await uninstallDesktopExtension(location);
  expect(await readDesktopExtensionSettings(location)).toEqual(last);
  await truncate(path.join(settings, "settings.json"), DESKTOP_EXTENSION_SETTINGS_MAX_BYTES + 1);
  await expect(readDesktopExtensionSettings(location)).rejects.toThrow("exceeds its limit");
});

it.runIf(process.platform === "win32")(
  "replaces settings after an active reader closes",
  async () => {
    const location = { dataDir, id };
    await writeDesktopExtensionSettings({ ...location, values: { revision: 1 } });
    const directory = path.join(dataDir, "desktop-extension-data", id);
    const reader = await open(path.join(directory, "settings.json"), "r");
    const close = delay(60).then(() => reader.close());
    try {
      await writeDesktopExtensionSettings({ ...location, values: { revision: 2 } });
    } finally {
      await close;
    }
    expect(await readDesktopExtensionSettings(location)).toEqual({ revision: 2 });
    expect(await readdir(directory)).toEqual(["settings.json"]);
  },
);

it("requires a bounded backend entry at installation and discovery", async () => {
  const extensionsRoot = desktopExtensionsRoot(dataDir);
  const manifest = { desktop: undefined, backend: { script: "backend.mjs" } };
  const install = (data?: string | Buffer) =>
    installFromZipBuffer({
      extensionsRoot,
      zipBuffer: extensionZip({
        manifest,
        extras: data === undefined ? [] : [{ name: "backend.mjs", data }],
      }),
    });
  await expect(install()).rejects.toThrow("Missing backend entry file backend.mjs");
  await expect(install(Buffer.alloc(DESKTOP_EXTENSION_SCRIPT_MAX_BYTES + 1))).rejects.toThrow(
    "exceeds its limit",
  );
  await expect(
    install('throw new Error("must not execute during installation");'),
  ).resolves.toMatchObject({ extensionId: id });
  expect((await discoverDesktopExtensions(extensionsRoot)).extensions).toEqual([
    {
      id,
      state: "valid",
      manifest: expect.objectContaining({ backend: manifest.backend }),
      hash: expect.any(String),
      backend: expect.objectContaining({ scriptPath: expect.stringMatching(/backend\.mjs$/u) }),
    },
  ]);
  await rm(path.join(directory, "backend.mjs"));
  expect((await discoverDesktopExtensions(extensionsRoot)).extensions).toMatchObject([
    { id, state: "invalid", error: "Missing backend entry file backend.mjs" },
  ]);
});
