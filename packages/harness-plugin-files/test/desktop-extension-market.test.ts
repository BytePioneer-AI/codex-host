import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { extensionZip } from "../../../tests/fixtures/desktop-extension-zip.js";
import seed from "../../../registry/desktop-extensions/catalog.json";
import {
  desktopExtensionsRoot,
  fetchDesktopExtensionCatalog,
  installFromCatalog,
  installFromUrl,
  installFromZipBuffer,
  listDesktopExtensions,
  uninstallDesktopExtension,
  updateDesktopExtensionSelection,
} from "../src/index.js";

let dataDir: string;
let extensionsRoot: string;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "desktop-extension-market-"));
  extensionsRoot = desktopExtensionsRoot(dataDir);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

it("installs STORE and DEFLATE resources, then replaces an enabled extension and uninstalls it", async () => {
  expect(
    await installFromZipBuffer({
      extensionsRoot,
      zipBuffer: extensionZip({ wrapper: "owner-repo-sha" }),
    }),
  ).toMatchObject({ extensionId: "sample", version: "1.0.0", replaced: false });
  await updateDesktopExtensionSelection(dataDir, {
    action: "enable",
    id: "sample",
    expectedRevision: 1,
  });
  expect(
    await installFromZipBuffer({ extensionsRoot, zipBuffer: extensionZip({ version: "2.0.0" }) }),
  ).toMatchObject({ version: "2.0.0", replaced: true });
  expect(await listDesktopExtensions(dataDir)).toMatchObject({
    configuration: { enabled: ["sample"], revision: 3 },
    extensions: [
      { id: "sample", enabled: true, status: { state: "waiting" }, manifest: { version: "2.0.0" } },
    ],
  });
  expect(await uninstallDesktopExtension({ dataDir, id: "sample" })).toMatchObject({
    removedId: "sample",
    list: { configuration: { enabled: [], revision: 4 }, extensions: [] },
  });
  expect(await readdir(extensionsRoot)).toEqual(["enabled.json"]);
});

it.each([
  "../outside",
  "wrapper\\..\\outside",
  "/absolute",
  "C:\\outside",
  "a\0b",
  "evil:stream",
  "Foo/../outside",
  "MANIFEST.JSON",
])("rejects unsafe or colliding ZIP entry %j", async (name) => {
  await expect(
    installFromZipBuffer({ extensionsRoot, zipBuffer: extensionZip({ extras: [{ name }] }) }),
  ).rejects.toThrow(/unsafe entry path|conflicting entry path/u);
  expect(await readdir(dataDir)).toEqual([]);
});

it("rejects symlinks, oversized archives, excessive entries, expanded data and a bad digest", async () => {
  for (const [archive, message] of [
    [extensionZip({ extras: [{ name: "symlink", mode: 0xa000, data: "desktop.js" }] }), "symlink"],
    [Buffer.alloc(5 * 1024 * 1024 + 1), "5 MiB"],
    [extensionZip({ extras: Array.from({ length: 49 }, (_, i) => ({ name: `f${i}` })) }), "1–50"],
    [
      extensionZip({
        extras: [{ name: "large", data: Buffer.alloc(10 * 1024 * 1024), deflate: true }],
      }),
      "10 MiB",
    ],
  ] as const)
    await expect(installFromZipBuffer({ extensionsRoot, zipBuffer: archive })).rejects.toThrow(
      message,
    );
  await expect(
    installFromZipBuffer({
      extensionsRoot,
      zipBuffer: extensionZip(),
      expectedSha256: "0".repeat(64),
    }),
  ).rejects.toThrow("SHA-256 mismatch");
  expect(await readdir(dataDir)).toEqual([]);
});

it("rolls back an update if writing the new configuration fails after the directory swap", async () => {
  await installFromZipBuffer({ extensionsRoot, zipBuffer: extensionZip() });
  const manifest = path.join(extensionsRoot, "sample", "manifest.json");
  const before = await readFile(manifest, "utf8");
  // The real filesystem refuses the atomic configuration rename over a directory.
  await rm(path.join(extensionsRoot, "enabled.json"));
  await mkdir(path.join(extensionsRoot, "enabled.json"));
  await expect(
    installFromZipBuffer({ extensionsRoot, zipBuffer: extensionZip({ version: "2.0.0" }) }),
  ).rejects.toThrow(/EISDIR|EPERM|EEXIST/u);
  expect(await readFile(manifest, "utf8")).toBe(before);
  expect((await readdir(extensionsRoot)).sort()).toEqual(["enabled.json", "sample"]);
});

it("resolves GitHub Releases without using the source zipball", async () => {
  const repository = "https://github.com/owner/repo/";
  const asset = "https://github.com/owner/repo/releases/download/v1/extension.zip";
  let release: Response;
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "https://api.github.com/repos/owner/repo/releases/latest") return release;
    if (url === asset) return new Response(new Uint8Array(extensionZip()));
    throw new Error(`Unexpected request: ${url}`);
  });
  release = new Response(null, { status: 404 });
  await expect(installFromUrl({ extensionsRoot, url: repository })).rejects.toThrow(
    "no public stable Release",
  );
  release = Response.json({ zipball_url: asset, assets: [] });
  await expect(installFromUrl({ extensionsRoot, url: repository })).rejects.toThrow(
    "no .zip asset",
  );
  release = Response.json({ assets: [{ name: "extension.zip", browser_download_url: asset }] });
  expect(await installFromUrl({ extensionsRoot, url: repository })).toMatchObject({
    extensionId: "sample",
  });
});

it("reads a local override, caches for five minutes, refreshes on demand and falls back to official entries", async () => {
  const file = path.join(dataDir, "catalog.json");
  const environment = { CODEXHOST_DESKTOP_EXTENSIONS_CATALOG_URL: file };
  const clock = vi.spyOn(Date, "now").mockReturnValue(0);
  await writeFile(file, JSON.stringify({ ...seed, extensions: [] }));
  expect(await fetchDesktopExtensionCatalog({ environment })).toMatchObject({
    source: "remote",
    cached: false,
    catalogUrl: file,
    extensions: [],
  });
  await writeFile(file, "not JSON");
  clock.mockReturnValue(299_999);
  expect(await fetchDesktopExtensionCatalog({ environment })).toMatchObject({
    source: "remote",
    cached: true,
  });
  clock.mockReturnValue(300_000);
  expect(await fetchDesktopExtensionCatalog({ environment })).toMatchObject({
    source: "fallback",
    cached: false,
    error: expect.any(String),
    extensions: seed.extensions,
  });
  await writeFile(file, JSON.stringify(seed));
  expect(await fetchDesktopExtensionCatalog({ environment, forceRefresh: true })).toMatchObject({
    source: "remote",
    cached: false,
  });
});

it("uses the mirror on primary failure and refuses an archive with a different catalog ID", async () => {
  const zip = extensionZip();
  const initial = seed.extensions[0];
  if (!initial) throw new Error("Missing official seed");
  const entry = { ...initial, sha256: createHash("sha256").update(zip).digest("hex") };
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.startsWith("https://raw.githubusercontent.com/"))
      return new Response(null, { status: 404 });
    if (url.startsWith("https://cdn.jsdelivr.net/"))
      return Response.json({ ...seed, extensions: [entry] });
    if (url === entry.downloadUrl) return new Response(new Uint8Array(zip));
    throw new Error(`Unexpected request: ${url}`);
  });
  expect(await fetchDesktopExtensionCatalog({ environment: {}, forceRefresh: true })).toMatchObject(
    { source: "remote", catalogUrl: expect.stringContaining("cdn.jsdelivr.net") },
  );
  await expect(
    installFromCatalog({ extensionsRoot, environment: {}, id: entry.id }),
  ).rejects.toThrow("Manifest id or version");
  expect((await listDesktopExtensions(dataDir)).extensions).toEqual([]);
});
