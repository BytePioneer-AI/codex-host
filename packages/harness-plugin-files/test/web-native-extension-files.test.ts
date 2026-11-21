import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { extensionZip, makeZip } from "../../../tests/fixtures/desktop-extension-zip.js";
import {
  discoverWebNativeExtensions,
  prepareWebNativeExtension,
  readExtensionZip,
  readWebNativeExtensionAsset,
  readWebNativeExtensionBackend,
  readWebNativeExtensionSettings,
  uninstallWebNativeExtension,
  WebNativeExtensionInstallConflict,
  writeWebNativeExtensionSettings,
} from "../src/index.js";

const archive = (version: string) =>
  makeZip([
    {
      name: "release/manifest.json",
      data: JSON.stringify({
        manifestVersion: 2,
        id: "sample",
        name: "Sample",
        version,
        web: { apiVersion: 1, entry: "web.mjs", style: "web.css" },
        backend: { apiVersion: 1, entry: "assets/backend.mjs" },
      }),
    },
    {
      name: "release/web.mjs",
      data: "throw new Error('must not run during install')",
      deflate: true,
    },
    { name: "release/web.css", data: ".example { color: red; }" },
    {
      name: "release/assets/backend.mjs",
      data: "throw new Error('not evaluated by file primitives')",
    },
    { name: "release/assets/panel.json", data: "{}" },
  ]);

it("switches a Web package only on commit, preserving settings across update and uninstall", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "web-native-files-"));
  const location = { dataDir, id: "sample" };
  const list = () =>
    discoverWebNativeExtensions(dataDir).then(({ installations }) =>
      installations.map(({ manifest }) => manifest.version),
    );
  try {
    expect(await list()).toEqual([]);
    expect(await readWebNativeExtensionSettings(location)).toEqual({});
    const first = await prepareWebNativeExtension({ dataDir, zipBuffer: archive("1") });
    expect(await list()).toEqual([]);
    const installed = await first.commit(null);
    expect(await readWebNativeExtensionBackend(installed)).toMatchObject({
      scriptPath: path.join(installed.directory, "assets", "backend.mjs"),
    });
    expect(await readWebNativeExtensionAsset(installed, "assets/panel.json")).toMatchObject({
      mimeType: "application/json",
    });
    await expect(readWebNativeExtensionAsset(installed, "assets/backend.mjs")).rejects.toThrow(
      "not a public",
    );
    await expect(readWebNativeExtensionAsset(installed, "manifest.json")).rejects.toThrow(
      "not a public",
    );
    await writeWebNativeExtensionSettings({ ...location, values: { compact: true } });

    const second = await prepareWebNativeExtension({ dataDir, zipBuffer: archive("2") });
    expect(await list()).toEqual(["1"]);
    await expect(second.commit(null)).rejects.toBeInstanceOf(WebNativeExtensionInstallConflict);
    expect(await list()).toEqual(["1"]);
    const retry = await prepareWebNativeExtension({ dataDir, zipBuffer: archive("2") });
    await retry.commit(first.digest);
    expect(await list()).toEqual(["2"]);
    expect(await uninstallWebNativeExtension(location)).toBe(true);
    expect(await list()).toEqual([]);
    expect(await readWebNativeExtensionSettings(location)).toEqual({ compact: true });
    await expect(prepareWebNativeExtension({ dataDir, zipBuffer: extensionZip() })).rejects.toThrow(
      "manifest v2",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

it("rejects traversal, links, case collisions and oversized entries even outside the selected wrapper subtree", async () => {
  for (const extras of [
    [{ name: "release/../escape" }],
    [{ name: "release/link", mode: 0xa000 }],
    [{ name: "release/Other/one" }, { name: "release/other/two" }],
    [{ name: "release/oversized", data: Buffer.alloc(17 * 1024 * 1024), deflate: true }],
  ]) {
    await expect(
      readExtensionZip(makeZip([{ name: "release/pkg/manifest.json" }, ...extras]), "pkg"),
    ).rejects.toThrow();
  }
});
