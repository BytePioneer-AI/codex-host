import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DESKTOP_EXTENSION_ICON_MAX_BYTES,
  type DesktopExtensionCatalog,
  type DesktopExtensionCatalogEntry,
} from "@codexhost/shared-contracts";
import { extensionZip, makeZip } from "../../../tests/fixtures/desktop-extension-zip.js";
import {
  DEFAULT_DESKTOP_EXTENSION_STATS_URL,
  reportDesktopExtensionInstall,
  resolveDesktopExtensionStatsUrl,
} from "../src/desktop-extension-installer.js";
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

const fsHooks = vi.hoisted(() => ({
  beforeRename: undefined as ((destination: string) => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>();
  return {
    ...fs,
    async rename(source: string, destination: string) {
      await fsHooks.beforeRename?.(destination);
      return fs.rename(source, destination);
    },
  };
});

let dataDir: string;
let extensionsRoot: string;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "desktop-extension-market-"));
  extensionsRoot = desktopExtensionsRoot(dataDir);
});
afterEach(async () => {
  fsHooks.beforeRename = undefined;
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

it("installs a declared logo and exposes it in the management list", async () => {
  const icon = "images/logo.webp";
  const bytes = Buffer.from("RIFF\0\0\0\0WEBP");
  await installFromZipBuffer({
    extensionsRoot,
    zipBuffer: extensionZip({ manifest: { icon }, extras: [{ name: icon, data: bytes }] }),
  });
  expect((await listDesktopExtensions(dataDir)).extensions).toMatchObject([
    { manifest: { icon }, iconDataUrl: `data:image/webp;base64,${bytes.toString("base64")}` },
  ]);
});

it.each([
  ["missing", undefined, /file not found/u],
  ["oversize", Buffer.alloc(DESKTOP_EXTENSION_ICON_MAX_BYTES + 1), /exceeds its limit/u],
  ["mislabeled", Buffer.from([0xff, 0xd8, 0xff]), /signature does not match image\/png/u],
] as const)("rejects a ZIP with a %s declared logo", async (_kind, bytes, reason) => {
  const icon = "images/logo.png";
  await expect(
    installFromZipBuffer({
      extensionsRoot,
      zipBuffer: extensionZip({
        manifest: { icon },
        extras: bytes ? [{ name: icon, data: bytes }] : [],
      }),
    }),
  ).rejects.toThrow(reason);
  expect(await readdir(extensionsRoot)).toEqual([]);
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

it("rejects symlinks, excessive entries, extreme compression and a bad digest", async () => {
  for (const [archive, message] of [
    [extensionZip({ extras: [{ name: "symlink", mode: 0xa000, data: "desktop.js" }] }), "symlink"],
    [
      extensionZip({ extras: Array.from({ length: 10_000 }, (_, i) => ({ name: `f${i}` })) }),
      "1–10000",
    ],
    [
      extensionZip({
        extras: [{ name: "large", data: Buffer.alloc(17 * 1024 * 1024), deflate: true }],
      }),
      "safety compression ratio",
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

it("keeps the enabled package visible when a concurrent scan races a failed configuration commit", async () => {
  const { installedPath } = await installFromZipBuffer({
    extensionsRoot,
    zipBuffer: extensionZip(),
  });
  await updateDesktopExtensionSelection(dataDir, {
    action: "enable",
    id: "sample",
    expectedRevision: 1,
  });
  const manifest = path.join(installedPath, "manifest.json");
  const before = await readFile(manifest, "utf8");
  const commit = Promise.withResolvers<undefined>();
  const resume = Promise.withResolvers<undefined>();
  fsHooks.beforeRename = async (destination) => {
    if (path.basename(destination) !== "enabled.json") return;
    commit.resolve(undefined);
    await resume.promise;
    throw new Error("injected enabled.json commit failure");
  };
  const failed = expect(
    installFromZipBuffer({ extensionsRoot, zipBuffer: extensionZip({ version: "2.0.0" }) }),
  ).rejects.toThrow("injected enabled.json commit failure");
  await commit.promise;
  const scan = listDesktopExtensions(dataDir);
  try {
    // A running backend can still access files directly while the commit is pending.
    expect(await readFile(manifest, "utf8")).toBe(before);
  } finally {
    resume.resolve(undefined);
    await failed;
    await scan;
  }
  expect(await scan).toMatchObject({
    configuration: { enabled: ["sample"], revision: 2 },
    extensions: [{ id: "sample", enabled: true, manifest: { version: "1.0.0" } }],
  });
  expect((await readdir(extensionsRoot)).sort()).toEqual(["enabled.json", "sample"]);
});

const githubApi = "https://api.github.com/repos/owner/repo";
const githubRequest = {
  headers: {
    accept: "application/vnd.github+json",
    "user-agent": expect.any(String),
  },
  redirect: "follow",
};

it("prefers the GitHub Release ZIP asset over the source zipball", async () => {
  const asset = "https://github.com/owner/repo/releases/download/v1/extension.zip";
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === `${githubApi}/releases/latest`)
      return Response.json({ assets: [{ name: "extension.zip", browser_download_url: asset }] });
    if (url === asset) return new Response(new Uint8Array(extensionZip()));
    throw new Error(`Unexpected request: ${url}`);
  });
  expect(
    await installFromUrl({ extensionsRoot, url: "https://github.com/owner/repo/" }),
  ).toMatchObject({
    extensionId: "sample",
  });
});

it.each([
  ["https://github.com/owner/repo", () => new Response(null, { status: 404 })],
  [
    "https://github.com/owner/repo.git/",
    () => Response.json({ assets: [{ name: "preview.png" }] }),
  ],
] as const)(
  "installs from the default-branch zipball for %s without a Release ZIP",
  async (url, release) => {
    const fetch = vi.fn(async (input: string) => {
      if (input === `${githubApi}/releases/latest`) return release();
      if (input === `${githubApi}/zipball`)
        return new Response(new Uint8Array(extensionZip({ wrapper: "owner-repo-sha" })));
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetch);
    expect(await installFromUrl({ extensionsRoot, url })).toMatchObject({ extensionId: "sample" });
    expect(fetch).toHaveBeenCalledWith(
      `${githubApi}/releases/latest`,
      expect.objectContaining(githubRequest),
    );
    expect(fetch).toHaveBeenCalledWith(
      `${githubApi}/zipball`,
      expect.objectContaining(githubRequest),
    );
  },
);

it("installs only the selected GitHub tree subdirectory and handles an encoded ref", async () => {
  const wrapper = "owner-repo-sha";
  const directory = `${wrapper}/packages/my extension`;
  const zip = extensionZip({
    wrapper: directory,
    extras: [
      { name: `${wrapper}/manifest.json`, data: "not the selected manifest" },
      { name: `${directory}-other/desktop.js` },
      { name: `${directory}/assets/note.txt`, data: "selected resource" },
    ],
  });
  vi.stubGlobal("fetch", async (url: string) => {
    expect(url).toBe(`${githubApi}/zipball/feature%2Fsidebar`);
    return new Response(new Uint8Array(zip));
  });
  const { installedPath } = await installFromUrl({
    extensionsRoot,
    url: "https://github.com/owner/repo/tree/feature%2Fsidebar/packages/my%20extension/",
  });
  expect((await readdir(installedPath)).sort()).toEqual(["assets", "desktop.js", "manifest.json"]);
  expect(await readFile(path.join(installedPath, "assets/note.txt"), "utf8")).toBe(
    "selected resource",
  );
});

it.each([
  ["https://github.com/owner/repo/tree/v1.0.0", `${githubApi}/zipball/v1.0.0`],
  [
    "https://codeload.github.com/owner/repo/zip/refs/heads/main",
    "https://codeload.github.com/owner/repo/zip/refs/heads/main",
  ],
])("downloads %s directly without doing a Release lookup", async (url, expectedUrl) => {
  vi.stubGlobal("fetch", async (input: string) => {
    expect(input).toBe(expectedUrl);
    return new Response(new Uint8Array(extensionZip({ wrapper: "owner-repo-sha" })));
  });
  expect(await installFromUrl({ extensionsRoot, url })).toMatchObject({ extensionId: "sample" });
});

it.each(["plugins/../extension", "plugins/%2E%2E/extension", "extension%00"])(
  "rejects unsafe GitHub tree subdirectory %s before downloading",
  async (subpath) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      installFromUrl({ extensionsRoot, url: `https://github.com/owner/repo/tree/main/${subpath}` }),
    ).rejects.toThrow("Invalid GitHub tree ref or subdirectory");
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("validates paths and file types outside the selected subdirectory", async () => {
  const wrapper = "owner-repo-sha";
  for (const [extra, error] of [
    [{ name: `${wrapper}/elsewhere/../outside` }, "unsafe entry path"],
    [{ name: `${wrapper}/elsewhere/symlink`, mode: 0xa000 }, "symlink"],
  ] as const) {
    const zip = extensionZip({ wrapper: `${wrapper}/extension`, extras: [extra] });
    await expect(
      installFromZipBuffer({ extensionsRoot, zipBuffer: zip, subpath: "extension" }),
    ).rejects.toThrow(error);
  }
  expect(await readdir(dataDir)).toEqual([]);
});

it("reports a missing manifest and suggests how to publish a missing entry file", async () => {
  const url = "https://github.com/owner/repo/tree/main";
  let zip = makeZip([{ name: "owner-repo-sha/README.md" }]);
  vi.stubGlobal("fetch", async () => new Response(new Uint8Array(zip)));
  await expect(installFromUrl({ extensionsRoot, url })).rejects.toThrow("missing manifest.json");
  zip = extensionZip({
    wrapper: "owner-repo-sha",
    manifest: { desktop: { script: "dist/entry.js" } },
    extras: [{ name: "owner-repo-sha/src/index.ts" }],
  });
  await expect(installFromUrl({ extensionsRoot, url })).rejects.toThrow(
    "Missing entry file dist/entry.js. Commit the built JavaScript entry or publish a Release .zip.",
  );
  expect(await readdir(extensionsRoot)).toEqual([]);
});

it("downloads and installs a ZIP above 5 MiB with more than 10 MiB of extracted resources", async () => {
  const zip = extensionZip({
    extras: [
      { name: "asset.bin", data: Buffer.alloc(6 * 1024 * 1024) },
      { name: "compressed.bin", data: Buffer.alloc(6 * 1024 * 1024), deflate: true },
    ],
  });
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(new Uint8Array(zip), {
        headers: { "content-length": String(zip.length) },
      }),
  );
  const { installedPath } = await installFromUrl({
    extensionsRoot,
    url: "https://example.com/sample.zip",
  });
  expect((await readFile(path.join(installedPath, "asset.bin"))).length).toBe(6 * 1024 * 1024);
  expect((await readFile(path.join(installedPath, "compressed.bin"))).length).toBe(6 * 1024 * 1024);
});

function catalogEntry(zip: Buffer, id = "sample"): DesktopExtensionCatalogEntry {
  return {
    id,
    version: "1.0.0",
    name: { en: "Sample", "zh-CN": "示例" },
    description: { en: "Test extension", "zh-CN": "测试扩展" },
    author: "Fixture Author",
    repository: "https://github.com/owner/sample",
    trustTier: "community",
    downloadUrl: "https://example.com/sample.zip",
    sha256: createHash("sha256").update(zip).digest("hex"),
  };
}

function catalogFixture(entry: DesktopExtensionCatalogEntry): DesktopExtensionCatalog {
  return { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", extensions: [entry] };
}

it("reads a local override, caches for five minutes, refreshes on demand and falls back to an empty list", async () => {
  const file = path.join(dataDir, "catalog.json");
  const environment = { CODEXHOST_DESKTOP_EXTENSIONS_CATALOG_URL: file };
  const catalog = catalogFixture(catalogEntry(extensionZip()));
  const clock = vi.spyOn(Date, "now").mockReturnValue(0);
  await writeFile(file, JSON.stringify(catalog));
  const remote = { source: "remote", catalogUrl: file, extensions: catalog.extensions };
  expect(await fetchDesktopExtensionCatalog({ environment })).toMatchObject({
    ...remote,
    cached: false,
  });
  await writeFile(file, "not JSON");
  clock.mockReturnValue(299_999);
  expect(await fetchDesktopExtensionCatalog({ environment })).toMatchObject({
    ...remote,
    cached: true,
  });
  clock.mockReturnValue(300_000);
  expect(await fetchDesktopExtensionCatalog({ environment })).toMatchObject({
    source: "fallback",
    cached: false,
    error: expect.any(String),
    extensions: [],
  });
  await writeFile(file, JSON.stringify(catalog));
  expect(await fetchDesktopExtensionCatalog({ environment, forceRefresh: true })).toMatchObject({
    ...remote,
    cached: false,
  });
});

it("reports a successful catalog install once without waiting for the response", async () => {
  const zip = extensionZip();
  const entry = catalogEntry(zip);
  const file = path.join(dataDir, "catalog.json");
  await writeFile(file, JSON.stringify(catalogFixture(entry)));
  const report = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", (input: string | URL, init: RequestInit) => {
    if (input === entry.downloadUrl) return new Response(new Uint8Array(zip));
    expect(String(input)).toBe("https://stats.example/install/sample");
    expect(init.method).toBe("POST");
    return report();
  });
  await expect(
    installFromCatalog({
      extensionsRoot,
      id: entry.id,
      environment: {
        CODEXHOST_DESKTOP_EXTENSIONS_CATALOG_URL: file,
        CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL: "https://stats.example/",
      },
    }),
  ).resolves.toMatchObject({ extensionId: "sample" });
  expect(report).toHaveBeenCalledOnce();
});

it("uses the mirror on primary failure and refuses an archive with a different catalog ID", async () => {
  const zip = extensionZip();
  const entry = catalogEntry(zip, "other");
  const fetch = vi.fn(async (url: string) => {
    if (url.startsWith("https://raw.githubusercontent.com/"))
      return new Response(null, { status: 404 });
    if (url.startsWith("https://cdn.jsdelivr.net/")) return Response.json(catalogFixture(entry));
    if (url === entry.downloadUrl) return new Response(new Uint8Array(zip));
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  expect(await fetchDesktopExtensionCatalog({ environment: {}, forceRefresh: true })).toMatchObject(
    { source: "remote", catalogUrl: expect.stringContaining("cdn.jsdelivr.net") },
  );
  await expect(
    installFromCatalog({
      extensionsRoot,
      id: entry.id,
      environment: { CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL: "https://stats.example/" },
    }),
  ).rejects.toThrow("Manifest id or version");
  expect(fetch.mock.calls.map(([url]) => String(url))).not.toContain(
    `https://stats.example/install/${entry.id}`,
  );
  expect((await listDesktopExtensions(dataDir)).extensions).toEqual([]);
});

it("posts only the encoded ID to the configured base URL and bounds the request time", async () => {
  const fetch = vi.fn<(_url: URL, _init: RequestInit) => Promise<Response>>(async () =>
    Response.json({ downloads: 1 }),
  );
  vi.stubGlobal("fetch", fetch);
  const timeout = vi.spyOn(AbortSignal, "timeout");
  await reportDesktopExtensionInstall(
    "sample/one",
    "https://stats.example/base/?private=1#fragment",
  );
  expect(fetch).toHaveBeenCalledWith(new URL("https://stats.example/base/install/sample%2Fone"), {
    method: "POST",
    credentials: "omit",
    redirect: "error",
    signal: expect.any(AbortSignal),
  });
  expect(timeout).toHaveBeenCalledWith(2_000);
});

it.each([
  ["network error", () => Promise.reject(new Error("offline"))],
  ["HTTP failure", () => new Response("unavailable", { status: 503 })],
])("silently ignores a stats %s", async (_label, fetch) => {
  vi.stubGlobal("fetch", fetch);
  await expect(
    reportDesktopExtensionInstall("sample", "https://stats.example"),
  ).resolves.toBeUndefined();
});

it("resolves default, opt-out, custom-catalog, and explicit stats URLs", () => {
  expect(resolveDesktopExtensionStatsUrl({})).toBe(DEFAULT_DESKTOP_EXTENSION_STATS_URL);
  expect(resolveDesktopExtensionStatsUrl({ CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL: "off" })).toBe(
    undefined,
  );
  expect(resolveDesktopExtensionStatsUrl({ CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL: "none" })).toBe(
    undefined,
  );
  expect(
    resolveDesktopExtensionStatsUrl({
      CODEXHOST_DESKTOP_EXTENSIONS_CATALOG_URL: "https://custom.example/catalog.json",
    }),
  ).toBe(undefined);
  expect(
    resolveDesktopExtensionStatsUrl({
      CODEXHOST_DESKTOP_EXTENSIONS_CATALOG_URL: "https://custom.example/catalog.json",
      CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL: "https://stats.example",
    }),
  ).toBe("https://stats.example");
});

it("skips missing, invalid or credentialed stats URLs", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  for (const url of [
    undefined,
    "not a URL",
    "file:///tmp/stats",
    "https://user:secret@stats.example",
  ]) {
    await reportDesktopExtensionInstall("sample", url);
  }
  expect(fetch).not.toHaveBeenCalled();
});
