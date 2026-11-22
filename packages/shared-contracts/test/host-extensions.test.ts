import { expect, it } from "vitest";
import {
  CLIENT_CHANNEL_METHODS,
  clientChannelEventSchema,
  DESKTOP_EXTENSION_ICON_MAX_BYTES,
  HOST_EXTENSION_MANAGEMENT_METHODS,
  HOST_EXTENSION_PAGE_API_VERSION,
  HOST_EXTENSION_PAGE_CSS_VARIABLES,
  HOST_EXTENSIONS_RPC,
  hostExtensionAssetUrl,
  hostExtensionCapabilities,
  hostExtensionCatalogEntrySchema,
  hostExtensionListItemSchema,
  hostExtensionManifestV2Schema,
  hostExtensionTargets,
  hostExtensionsRpcSchemas,
  isHostExtensionManagementMethod,
  parseHostExtensionManifest,
} from "../src/index.js";

const localized = { en: "Fixture", "zh-CN": "测试" };
const header = {
  manifestVersion: 2,
  id: "sample",
  name: localized,
  version: "1.0.0",
  description: localized,
};
const desktop = { apiVersion: 1, script: "desktop.js" };
const web = { apiVersion: 1, style: "web.css" };
const page = { apiVersion: 1, entry: "ui/page.mjs", style: "page.css", title: localized };
const backend = { apiVersion: 1, entry: "backend.mjs" };
const widget = { apiVersion: 1, entry: "widget/index.mjs", style: "widget/style.css" };

it.each([
  ["data:image/png;base64,YQ==", true, true],
  ["data:image/svg+xml;base64,YQ==", false, false],
  ["file:///tmp/screenshot.png", false, false],
  [
    `data:image/png;base64,${"AAAA".repeat(Math.ceil(DESKTOP_EXTENSION_ICON_MAX_BYTES / 3) + 1)}`,
    false,
    true,
  ],
])("validates raster previews (case %#)", (url, iconValid, screenshotValid) => {
  const item = {
    state: "valid",
    id: header.id,
    activationId: "00000000-0000-4000-8000-000000000000",
    digest: "a".repeat(64),
    installedAt: "2026-01-01T00:00:00.000Z",
    enabled: false,
    manifest: { ...header, desktop },
  };
  expect(hostExtensionListItemSchema.safeParse({ ...item, iconDataUrl: url }).success).toBe(
    iconValid,
  );
  expect(
    hostExtensionListItemSchema.safeParse({ ...item, screenshotDataUrls: [url] }).success,
  ).toBe(screenshotValid);
});

it.each([
  [{ desktop }, ["desktop"], [false, false, true, false, false]],
  [{ web }, ["web"], [false, false, false, true, false]],
  [{ page }, ["desktop", "web"], [true, false, false, false, false]],
  [{ widget }, ["desktop", "web"], [false, true, false, false, false]],
  [{ widget, desktop }, ["desktop", "web"], [false, true, true, false, false]],
  [{ backend }, ["desktop", "web"], [false, false, false, false, true]],
  [{ desktop, backend }, ["desktop"], [false, false, true, false, true]],
  [{ page, widget, desktop, web, backend }, ["desktop", "web"], [true, true, true, true, true]],
] as const)(
  "derives the capabilities and targets for %j",
  (entries, targets, [hasPage, hasWidget, hasDesktop, hasWeb, hasBackend]) => {
    const manifest = hostExtensionManifestV2Schema.parse({ ...header, ...entries });
    expect(hostExtensionCapabilities(manifest)).toEqual({
      hasPage,
      hasWidget,
      hasDesktop,
      hasWeb,
      hasBackend,
    });
    expect(hostExtensionTargets(manifest)).toEqual(targets);
  },
);

it.each([
  {},
  { web: { apiVersion: 1 } },
  { page: { apiVersion: 1, style: "page.css" } },
  { page: { ...page, entry: "../x.mjs" } },
  { page: { ...page, entry: "./x.mjs" } },
  { web: { ...web, entry: "C:\\entry.mjs" } },
  { desktop: { ...desktop, script: "app.mjs" } },
  { page: { ...page, entry: "BACKEND.mjs" }, backend },
  { widget: { ...widget, entry: "BACKEND.mjs" }, backend },
  { widget: { ...widget, entry: "widget.js" } },
  { widget: { ...widget, style: "../app.css" } },
  { widget: { ...widget, apiVersion: 2 } },
  { widget: { ...widget, title: localized } },
  { backend: { ...backend, targets: ["web"] } },
  { id: "con", desktop },
])("rejects invalid v2 input %j", (fields) => {
  expect(parseHostExtensionManifest({ ...header, ...fields }).state).toBe("invalid");
});

it("validates widget catalog targets", () => {
  const entry = {
    id: header.id,
    name: localized,
    description: localized,
    version: header.version,
    author: "Sample Author",
    repository: "https://example.org/sample",
    sha256: "a".repeat(64),
    format: "codexhost",
    targets: ["desktop", "web"],
    apis: { widget: 1 },
    downloadUrl: "https://example.org/sample.zip",
  };
  expect(hostExtensionCatalogEntrySchema.parse(entry).apis).toEqual({ widget: 1 });
  expect(
    hostExtensionCatalogEntrySchema.safeParse({ ...entry, targets: ["desktop"] }).success,
  ).toBe(false);
});

it("normalizes an existing v1 Desktop manifest and reports future versions", () => {
  const result = parseHostExtensionManifest({
    manifestVersion: 1,
    desktopApi: 1,
    id: "legacy",
    name: "Legacy",
    version: "1",
    description: { en: "Legacy description" },
    desktop: { script: "desktop.js" },
  });
  expect(result).toMatchObject({
    state: "valid",
    manifest: {
      manifestVersion: 2,
      name: { en: "Legacy", "zh-CN": "Legacy" },
      desktop,
      description: { en: "Legacy description", "zh-CN": "Legacy description" },
    },
  });
  if (result.state !== "valid") throw new Error(result.error);
  expect(hostExtensionTargets(result.manifest)).toEqual(["desktop"]);
  expect(parseHostExtensionManifest({ ...header, manifestVersion: 3 }).state).toBe("incompatible");
});

it("registers the entire RPC namespace and its invalidation event on the client channel", () => {
  expect(HOST_EXTENSION_MANAGEMENT_METHODS).toHaveLength(13);
  for (const method of HOST_EXTENSION_MANAGEMENT_METHODS) {
    expect(isHostExtensionManagementMethod(method)).toBe(true);
    expect(CLIENT_CHANNEL_METHODS).toContain(method);
    expect(hostExtensionsRpcSchemas[method]).toHaveProperty("params");
    expect(hostExtensionsRpcSchemas[method]).toHaveProperty("result");
  }
  expect(isHostExtensionManagementMethod("codexhost/extensions/unknown")).toBe(false);
  expect(
    CLIENT_CHANNEL_METHODS.some((method) => method.startsWith("codexhost/desktop/extensions/")),
  ).toBe(false);
  const event = {
    type: "extensions-changed",
    cursor: { epoch: "00000000-0000-4000-8000-000000000000", sequence: 1 },
    revision: 2,
  };
  expect(clientChannelEventSchema.parse(event)).toEqual(event);
  expect(clientChannelEventSchema.safeParse({ ...event, revision: -1 }).success).toBe(false);
});

it("validates install sources, asset refs, settings revisions, and backend JSON", () => {
  const install = hostExtensionsRpcSchemas[HOST_EXTENSIONS_RPC.install].params;
  for (const source of [
    { type: "catalog", id: "sample" },
    { type: "github", repository: "owner/repo", tag: "v1", asset: "sample.zip" },
    { type: "github", repository: "owner/repo", ref: "feature/test" },
    { type: "zip", base64: "AA==" },
    { type: "zip", localZipPath: "/uploads/sample.zip" },
    { type: "localDir", localDir: "C:\\plugins\\sample" },
  ])
    expect(install.safeParse({ source }).success).toBe(true);
  for (const source of [
    { type: "zip", base64: "AA==", localZipPath: "/uploads/sample.zip" },
    { type: "zip", base64: "%%%=" },
    { type: "github", repository: "owner/.." },
    { type: "localDir", localDir: "/plugins/../outside" },
  ])
    expect(install.safeParse({ source }).success).toBe(false);
  const asset = hostExtensionsRpcSchemas[HOST_EXTENSIONS_RPC.asset];
  const identity = {
    id: "sample",
    activationId: "00000000-0000-4000-8000-000000000000",
    digest: "a".repeat(64),
  };
  expect(asset.params.parse({ ...identity, path: "assets/a b.png" })).toMatchObject(identity);
  expect(hostExtensionAssetUrl({ ...identity, path: "assets/a b.png" })).toBe(
    `/api/extensions/assets/sample/${identity.activationId}/${identity.digest}/assets/a%20b.png`,
  );
  expect(() => hostExtensionAssetUrl({ ...identity, path: "../secret" })).toThrow();
  expect(asset.params.safeParse({ ...identity, digest: "broken", path: "page.mjs" }).success).toBe(
    false,
  );
  expect(
    asset.result.safeParse({ digest: identity.digest, base64: "AA==", mimeType: "image/png" })
      .success,
  ).toBe(true);
  expect(
    asset.result.safeParse({ digest: identity.digest, base64: "@@", mimeType: "image/png" })
      .success,
  ).toBe(false);
  expect(
    hostExtensionsRpcSchemas[HOST_EXTENSIONS_RPC.settingsSet].params.safeParse({
      id: "sample",
      values: {},
    }).success,
  ).toBe(false);
  expect(
    hostExtensionsRpcSchemas[HOST_EXTENSIONS_RPC.backendInvoke].result.safeParse({
      result: { ok: true },
    }).success,
  ).toBe(true);
  expect(HOST_EXTENSION_PAGE_API_VERSION).toBe(1);
  expect(Object.values(HOST_EXTENSION_PAGE_CSS_VARIABLES)).toHaveLength(8);
});
