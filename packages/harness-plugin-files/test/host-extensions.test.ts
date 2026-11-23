import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  HOST_EXTENSION_CATALOG_MIRROR_URL,
  HOST_EXTENSION_CATALOG_URL,
  hostExtensionsListResultSchema,
} from "@codexhost/shared-contracts";
import { makeZip } from "../../../tests/fixtures/desktop-extension-zip.js";
import {
  DEFAULT_HOST_EXTENSION_STATS_URL,
  discoverHostExtensions,
  fetchHostExtensionCatalog,
  HostExtensionInstallConflict,
  HostExtensionRevisionConflict,
  HostExtensionSettingsRevisionConflict,
  hostExtensionDataRoot,
  hostExtensionsRoot,
  installHostExtension,
  prepareHostExtension,
  readHostExtension,
  readHostExtensionAsset,
  readHostExtensionBackend,
  readHostExtensionConfiguration,
  readHostExtensionSettings,
  reportHostExtensionInstall,
  resolveHostExtensionStatsUrl,
  rollbackHostExtension,
  uninstallHostExtension,
  updateHostExtensionConfiguration,
  writeHostExtensionSettings,
} from "../src/index.js";

const label = { en: "Fixture", "zh-CN": "测试" };
const desktop = { apiVersion: 1, script: "desktop.js" };
const page = { apiVersion: 1, entry: "page.mjs", style: "page.css" };
const widget = { apiVersion: 1, entry: "widget/index.mjs", style: "widget/style.css" };
const backend = { apiVersion: 1, entry: "assets/backend.mjs" };
const slots = ["appearance.theme"];
const png = Buffer.from("89504e470d0a1a0a", "hex");
const script = "throw new Error('the installer must not execute this');";
const settingsSchema = [
  { type: "boolean", key: "compact", label, default: false },
  { type: "range", key: "size", label, min: 0, max: 10 },
];
const manifest = (id: string, fields: object) => ({
  id,
  manifestVersion: 2,
  version: "1",
  name: label,
  description: label,
  ...fields,
});
const archive = (data: object, files: Record<string, string | Buffer>) =>
  makeZip([
    { name: "release/manifest.json", data: JSON.stringify(data) },
    ...Object.entries(files).map(([name, data]) => ({ name: `release/${name}`, data })),
  ]);
const zipSource = (data: object, files: Record<string, string | Buffer>) => ({
  type: "zip" as const,
  zipBuffer: archive(data, files),
});

import { readExtensionZip } from "../src/extension-zip.js";

it("rejects invalid ZIP entries even outside the selected subtree", async () => {
  for (const extras of [
    [{ name: "release/../escape" }],
    [{ name: "release/link", mode: 0xa000 }],
    [{ name: "release/Other/one" }, { name: "release/other/two" }],
    [{ name: "release/oversized", data: Buffer.alloc(17 * 1024 * 1024), deflate: true }],
  ]) {
    await expect(
      readExtensionZip(
        makeZip([{ name: "release/pkg/manifest.json" }, ...extras]),
        "pkg",
        16 * 1024 * 1024,
      ),
    ).rejects.toThrow();
  }
});

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "host-extension-files-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dataDir, { force: true, recursive: true });
});

it("discovers all capabilities, isolates corruption, and applies slots only to enabled Desktop entries", async () => {
  const fixtures = [
    [
      manifest("frontend", { web: { apiVersion: 1, style: "web.css" }, slots }),
      { "web.css": "body {}" },
    ],
    [manifest("backend", { backend, slots }), { [backend.entry]: script }],
    [
      manifest("page", { page, slots, icon: "icon.png", screenshots: ["assets/shot.png"] }),
      { [page.entry]: script, [page.style]: "body {}", "icon.png": png, "assets/shot.png": png },
    ],
    [
      {
        manifestVersion: 1,
        desktopApi: 1,
        id: "legacy",
        name: "Legacy",
        version: "1",
        desktop: { script: desktop.script },
        slots,
      },
      { [desktop.script]: script },
    ],
    [
      manifest("both", { desktop, backend, slots }),
      { [desktop.script]: script, [backend.entry]: script },
    ],
    [manifest("damaged", { page }), { [page.entry]: script, [page.style]: "body{}" }],
  ] as const;
  const installed = new Map();
  for (const [input, files] of fixtures)
    installed.set(
      input.id,
      await installHostExtension({ dataDir, source: zipSource(input, files) }),
    );
  const configured = ["frontend", "backend", "page", "legacy", "both"];
  for (const [expectedRevision, id] of configured.entries())
    await updateHostExtensionConfiguration(dataDir, { id, action: "enable", expectedRevision });
  await writeFile(
    path.join(installed.get("damaged").directory, page.entry),
    "not the installed script",
  );
  const { installations, ...list } = await discoverHostExtensions(dataDir);
  expect(hostExtensionsListResultSchema.parse({ ...list, revision: 1 })).toBeTruthy();
  expect(installations.map(({ id }) => id)).toEqual([
    "backend",
    "both",
    "frontend",
    "legacy",
    "page",
  ]);
  expect(list.extensions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "damaged",
        state: "invalid",
        error: expect.stringContaining("digest mismatch"),
      }),
      expect.objectContaining({ id: "both", desktopConflictWith: "legacy", enabled: true }),
      expect.objectContaining({
        id: "page",
        iconDataUrl: `data:image/png;base64,${png.toString("base64")}`,
        screenshotDataUrls: [`data:image/png;base64,${png.toString("base64")}`],
      }),
      expect.objectContaining({
        id: "legacy",
        manifest: expect.objectContaining({ manifestVersion: 2, desktop }),
      }),
    ]),
  );
  expect(
    list.extensions.filter((entry) => "desktopConflictWith" in entry).map(({ id }) => id),
  ).toEqual(["both"]);
  expect(await readHostExtensionBackend({ dataDir, id: "backend" })).toMatchObject({
    scriptPath: path.join(installed.get("backend").directory, backend.entry),
  });
});

it("publishes only on commit and rolls back to a verified generation with a new activation", async () => {
  const location = { dataDir, id: "sample" };
  const bundle = (version: string, entry = script) =>
    zipSource(manifest(location.id, { page, version }), {
      [page.entry]: entry,
      [page.style]: "body{}",
    });
  const first = await installHostExtension({ dataDir, source: bundle("1") });
  const second = await prepareHostExtension({ dataDir, source: bundle("2") });
  expect(await readHostExtension(location)).toMatchObject({
    digest: first.digest,
    activationId: first.activationId,
  });
  await expect(second.commit({ expectedDigest: null })).rejects.toBeInstanceOf(
    HostExtensionInstallConflict,
  );
  await expect(
    installHostExtension({
      dataDir,
      expectedDigest: first.digest,
      source: zipSource(manifest("sample", { page }), {}),
    }),
  ).rejects.toThrow("Missing required");
  expect(await readHostExtension(location)).toMatchObject({ digest: first.digest });
  const next = await installHostExtension({
    dataDir,
    expectedDigest: first.digest,
    expectedActivationId: first.activationId,
    source: bundle("2"),
  });
  expect(next).toMatchObject({ replaced: true, manifest: { version: "2" } });
  expect(next.generation).not.toBe(first.generation);
  await expect(
    readHostExtensionAsset({ ...location, path: page.entry, activationId: first.activationId }),
  ).rejects.toBeInstanceOf(HostExtensionInstallConflict);
  const restored = await rollbackHostExtension({
    ...location,
    previous: first,
    expectedActivationId: next.activationId,
  });
  expect(restored).toMatchObject({ digest: first.digest, generation: first.generation });
  expect(restored.activationId).not.toBe(first.activationId);
  await expect(
    rollbackHostExtension({ ...location, previous: next, expectedActivationId: next.activationId }),
  ).rejects.toBeInstanceOf(HostExtensionInstallConflict);
  await writeFile(path.join(next.directory, page.entry), "tampered");
  await expect(
    rollbackHostExtension({
      ...location,
      previous: next,
      expectedActivationId: restored.activationId,
    }),
  ).rejects.toThrow("digest mismatch");
  expect(await readHostExtension(location)).toMatchObject({ activationId: restored.activationId });
});

it("reads indexed frontend modules, styles and static assets; rejects traversal, private and tampered files", async () => {
  const location = { dataDir, id: "sample" };
  const source = zipSource(manifest(location.id, { backend, page, widget }), {
    [backend.entry]: script,
    [page.entry]: script,
    [page.style]: "body {}",
    [widget.entry]: 'import "../shared/timer.mjs";',
    [widget.style]: ".timer {}",
    "assets/panel.json": "{}",
    "shared/timer.mjs": script,
    "outside.json": "{}",
  });
  const current = await installHostExtension({ dataDir, source });
  const get = (resource: string) =>
    readHostExtensionAsset({
      ...location,
      path: resource,
      digest: current.digest,
      activationId: current.activationId,
    });
  expect(await get(page.entry)).toEqual({
    digest: current.digest,
    mimeType: "text/javascript",
    base64: Buffer.from(script).toString("base64"),
  });
  expect(await get("assets/panel.json")).toMatchObject({ mimeType: "application/json" });
  expect(await get(widget.entry)).toMatchObject({ mimeType: "text/javascript" });
  expect(await get(widget.style)).toMatchObject({ mimeType: "text/css" });
  expect(await get("shared/timer.mjs")).toMatchObject({ mimeType: "text/javascript" });
  await writeFile(path.join(current.directory, widget.style), ".tampered {}");
  await expect(get(widget.style)).rejects.toThrow("digest mismatch");
  for (const resource of [
    backend.entry,
    "assets/BACKEND.mjs",
    "shared/missing.mjs",
    "outside.json",
    "manifest.json",
    "assets/../page.mjs",
    "./page.mjs",
  ])
    await expect(get(resource)).rejects.toThrow();
  await rm(path.join(current.directory, "assets/panel.json"));
  await symlink(
    path.join(current.directory, "outside.json"),
    path.join(current.directory, "assets/panel.json"),
  );
  await expect(get("assets/panel.json")).rejects.toThrow("Unsafe file");
});

it.each([widget.entry, widget.style])(
  "requires declared widget resource %s in the ZIP",
  async (missing) => {
    const files =
      missing === widget.entry ? { [widget.style]: ".timer {}" } : { [widget.entry]: script };
    await expect(
      installHostExtension({
        dataDir,
        source: zipSource(manifest("widget", { widget }), files),
      }),
    ).rejects.toThrow(`Missing required extension file: ${missing}`);
  },
);

it("guards local ZIPs and directory copies, rejects unsafe archive content and never publishes invalid packages", async () => {
  const source = zipSource(manifest("sample", { page }), {
    [page.entry]: script,
    [page.style]: "body {}",
  });
  const upload = path.join(dataDir, "upload");
  await mkdir(upload);
  const localZipPath = path.join(upload, "sample.zip");
  await writeFile(localZipPath, source.zipBuffer);
  const input = { type: "zip" as const, localZipPath };
  await expect(prepareHostExtension({ dataDir, source: input })).rejects.toThrow("controlled");
  await expect(
    prepareHostExtension({ dataDir, source: input, localZipRoot: path.join(dataDir, "another") }),
  ).rejects.toThrow();
  expect(
    await installHostExtension({ dataDir, source: input, localZipRoot: upload }),
  ).toMatchObject({ source: { type: "zip" } });
  const localDir = path.join(dataDir, "loose");
  await mkdir(localDir);
  await writeFile(
    path.join(localDir, "manifest.json"),
    JSON.stringify(manifest("loose", { desktop })),
  );
  await writeFile(path.join(localDir, desktop.script), script);
  await symlink(upload, path.join(localDir, "link"), "junction");
  await expect(
    prepareHostExtension({ dataDir, source: { type: "localDir", localDir } }),
  ).rejects.toThrow("Symlink");
  await rm(path.join(localDir, "link"));
  expect(
    await installHostExtension({ dataDir, source: { type: "localDir", localDir } }),
  ).toMatchObject({ id: "loose" });
  for (const extra of [
    { name: "../escape" },
    { name: "release/link", mode: 0xa000 },
    { name: "release/unsafe.exe" },
    { name: "release/big.js", data: Buffer.alloc(2 * 1024 * 1024 + 1) },
  ]) {
    const zipBuffer = makeZip([
      { name: "release/manifest.json", data: JSON.stringify(manifest("rejected", { desktop })) },
      { name: "release/desktop.js", data: script },
      extra,
    ]);
    await expect(
      prepareHostExtension({ dataDir, source: { type: "zip", zipBuffer } }),
    ).rejects.toThrow();
  }
  expect(await readHostExtension({ dataDir, id: "rejected" })).toBeUndefined();
});

it("serializes revision checks and preserves validated shared settings until explicit data removal", async () => {
  const location = { dataDir, id: "sample" };
  const source = zipSource(manifest(location.id, { backend, settingsSchema }), {
    [backend.entry]: script,
  });
  const installed = await installHostExtension({ dataDir, source });
  const write = (expectedSettingsRevision: number, values: Record<string, number | boolean>) =>
    writeHostExtensionSettings({
      ...location,
      activationId: installed.activationId,
      expectedSettingsRevision,
      values,
    });
  expect(await readHostExtensionSettings(location)).toEqual({
    settingsRevision: 0,
    values: { compact: false },
  });
  const selection = await Promise.allSettled([
    updateHostExtensionConfiguration(dataDir, {
      action: "enable",
      id: location.id,
      expectedRevision: 0,
    }),
    updateHostExtensionConfiguration(dataDir, { action: "disableAll", expectedRevision: 0 }),
  ]);
  expect(selection.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(selection).toContainEqual({
    status: "rejected",
    reason: expect.any(HostExtensionRevisionConflict),
  });
  expect(await readHostExtensionConfiguration(dataDir)).toMatchObject({ revision: 1 });
  expect(
    JSON.parse(await readFile(path.join(hostExtensionsRoot(dataDir), "enabled.json"), "utf8")),
  ).toMatchObject({ revision: 1 });
  await expect(write(0, { size: 11 })).rejects.toThrow("Invalid value");
  const settings = await Promise.allSettled([write(0, { size: 5 }), write(0, { size: 5 })]);
  expect(settings.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(settings).toContainEqual({
    status: "rejected",
    reason: expect.any(HostExtensionSettingsRevisionConflict),
  });
  const saved = { settingsRevision: 1, values: { compact: false, size: 5 } };
  expect(await readHostExtensionSettings(location)).toEqual(saved);
  expect(
    JSON.parse(
      await readFile(
        path.join(hostExtensionDataRoot(dataDir), location.id, "settings.json"),
        "utf8",
      ),
    ),
  ).toMatchObject({ settingsRevision: 1 });
  expect(await uninstallHostExtension(location)).toBe(true);
  expect((await readHostExtensionSettings(location)).values).toEqual({ size: 5 });
  expect((await readHostExtensionConfiguration(dataDir)).enabled).toEqual([]);
  const reinstalled = await installHostExtension({ dataDir, source });
  expect(await readHostExtensionSettings(location)).toEqual(saved);
  const upgraded = await installHostExtension({
    dataDir,
    expectedDigest: reinstalled.digest,
    source: zipSource(
      manifest(location.id, { version: "2", backend, settingsSchema: [settingsSchema[0]] }),
      { [backend.entry]: script },
    ),
  });
  expect(await readHostExtensionSettings(location)).toEqual({
    settingsRevision: 1,
    values: { compact: false },
  });
  await rollbackHostExtension({
    ...location,
    previous: reinstalled,
    expectedActivationId: upgraded.activationId,
  });
  expect(await readHostExtensionSettings(location)).toEqual(saved);
  expect(await uninstallHostExtension({ ...location, removeData: true })).toBe(true);
  expect(await readHostExtensionSettings(location)).toEqual({ settingsRevision: 0, values: {} });
});

it("races validated catalog mirrors, caches only successful results, and installs checksum-pinned releases", async () => {
  const zip = archive(manifest("sample", { backend }), { [backend.entry]: script });
  const url = "https://github.com/owner/repo/releases/download/v1/sample.zip";
  const catalog = {
    schemaVersion: 2,
    generatedAt: "today",
    extensions: [
      {
        id: "sample",
        version: "1",
        format: "codexhost",
        targets: ["desktop", "web"],
        apis: { backend: 1 },
        name: label,
        description: label,
        author: "Fixture",
        repository: "https://github.com/owner/repo",
        downloadUrl: url,
        sha256: createHash("sha256").update(zip).digest("hex"),
      },
    ],
  };
  let rawIsValid = false;
  const fetch = vi.fn(async (request: string) => {
    if (request === HOST_EXTENSION_CATALOG_URL)
      return rawIsValid ? Response.json(catalog) : Response.json({ schemaVersion: 1 });
    if (request === HOST_EXTENSION_CATALOG_MIRROR_URL) return Response.json(catalog);
    if (request === "https://api.github.com/repos/owner/repo/releases/tags/v1")
      return Response.json({ assets: [{ name: "sample.zip", browser_download_url: url }] });
    if (request === url || request === "https://api.github.com/repos/owner/repo/zipball/main")
      return new Response(Uint8Array.from(zip));
    throw new Error(`Unexpected URL ${request}`);
  });
  vi.stubGlobal("fetch", fetch);
  expect(await fetchHostExtensionCatalog({ forceRefresh: true })).toMatchObject({
    cached: false,
    catalogUrl: HOST_EXTENSION_CATALOG_MIRROR_URL,
  });
  expect(await fetchHostExtensionCatalog()).toMatchObject({
    cached: true,
    catalogUrl: HOST_EXTENSION_CATALOG_MIRROR_URL,
  });
  rawIsValid = true;
  expect(await fetchHostExtensionCatalog({ forceRefresh: true })).toMatchObject({
    cached: false,
    catalogUrl: HOST_EXTENSION_CATALOG_URL,
  });
  const installed = await installHostExtension({
    dataDir,
    source: { type: "catalog", id: "sample" },
  });
  expect(installed).toMatchObject({ source: { type: "catalog", id: "sample" } });
  const release = await prepareHostExtension({
    dataDir,
    source: { type: "github", repository: "owner/repo", tag: "v1", asset: "sample.zip" },
  });
  const zipball = await prepareHostExtension({
    dataDir,
    source: { type: "github", repository: "owner/repo", ref: "main" },
  });
  expect(release.digest).toBe(installed.digest);
  expect(zipball.digest).toBe(installed.digest);
  await release.dispose();
  await zipball.dispose();
  await expect(
    prepareHostExtension({
      dataDir,
      source: { type: "zip", zipBuffer: zip },
      expected: { id: "sample", sha256: "0".repeat(64) },
    }),
  ).rejects.toThrow("SHA-256 mismatch");
});

it("resolves extension stats URL overrides and reports catalog installs best-effort", async () => {
  expect(resolveHostExtensionStatsUrl({})).toBe(DEFAULT_HOST_EXTENSION_STATS_URL);
  expect(resolveHostExtensionStatsUrl({ CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL: "off" })).toBe(
    undefined,
  );
  expect(resolveHostExtensionStatsUrl({ CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL: "" })).toBe(
    undefined,
  );
  expect(
    resolveHostExtensionStatsUrl({
      CODEXHOST_DESKTOP_EXTENSIONS_CATALOG_URL: "https://custom.example/catalog.json",
    }),
  ).toBe(undefined);
  expect(
    resolveHostExtensionStatsUrl({
      CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL: "https://stats.example/counter/",
    }),
  ).toBe("https://stats.example/counter/");

  const calls: Array<{ url: string; method: string | undefined }> = [];
  vi.stubGlobal("fetch", async (url: URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    throw new Error("network unavailable");
  });

  await expect(
    reportHostExtensionInstall("focus-pomodoro", "https://stats.example/counter/"),
  ).resolves.toBeUndefined();
  await reportHostExtensionInstall("../invalid", "https://stats.example/counter/");
  await reportHostExtensionInstall("focus-pomodoro", undefined);

  expect(calls).toEqual([
    { url: "https://stats.example/counter/install/focus-pomodoro", method: "POST" },
  ]);
});
