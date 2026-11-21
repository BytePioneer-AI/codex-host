import { expect, it } from "vitest";
import {
  WEB_EXTENSIONS_RPC,
  extensionBackendTargets,
  extensionManifestTargets,
  codexHostExtensionManifestSchema,
  codexHostExtensionManifestV2Schema,
  desktopExtensionManifestSchema,
  encodeWebExtensionResourcePath,
  parseExtensionCatalogV2,
  webExtensionAssetBaseUrl,
  webExtensionRuntimeSnapshotSchema,
  webExtensionsRpcSchemas,
} from "../src/index.js";

const manifest = { manifestVersion: 2, id: "sample", name: "Sample", version: "1.0.0" };
const digest = "a".repeat(64);
const revision = "cc9c5fc2-1a91-425b-9f62-d377cafec46b";

it("preserves exact v1 parsing and determines which target can run each v2 backend", () => {
  const v1 = { ...manifest, manifestVersion: 1, desktopApi: 1, backend: { script: "backend.mjs" } };
  expect(codexHostExtensionManifestSchema.parse(v1)).toEqual(
    desktopExtensionManifestSchema.parse(v1),
  );
  expect(extensionManifestTargets(codexHostExtensionManifestSchema.parse(v1))).toEqual(["desktop"]);
  const v2 = codexHostExtensionManifestV2Schema.parse({
    ...manifest,
    web: { apiVersion: 1, style: "web.css" },
    backend: { apiVersion: 1, entry: "backend.mjs" },
  });
  expect(extensionBackendTargets(v2)).toEqual(["web"]);
  expect(
    extensionManifestTargets(
      codexHostExtensionManifestV2Schema.parse({
        ...manifest,
        backend: { apiVersion: 1, entry: "backend.mjs", targets: ["desktop", "web"] },
      }),
    ),
  ).toEqual(["desktop", "web"]);
  for (const web of [
    { apiVersion: 1 },
    { apiVersion: 1, entry: "../web.mjs" },
    { apiVersion: 1, entry: "con/web.mjs" },
  ]) {
    expect(codexHostExtensionManifestV2Schema.safeParse({ ...manifest, web }).success).toBe(false);
  }
  expect(
    codexHostExtensionManifestV2Schema.safeParse({ ...manifest, backend: v2.backend }).success,
  ).toBe(false);
});

it("binds browser entry URLs to the snapshot generation", () => {
  const identity = { id: "sample", digest, activationId: revision };
  const assetBaseUrl = webExtensionAssetBaseUrl(identity);
  const entry = {
    ...identity,
    version: "1",
    hasBackend: false,
    assetBaseUrl,
    settingsRevision: revision,
    entryUrl: `${assetBaseUrl}${encodeWebExtensionResourcePath("ui/my module.mjs")}`,
  };
  expect(
    webExtensionRuntimeSnapshotSchema.parse({ revision, extensions: [entry] }).extensions,
  ).toEqual([entry]);
  for (const entryUrl of [
    "//other.test/web.mjs",
    `${assetBaseUrl}%2e%2e/web.mjs`,
    `${assetBaseUrl}x%2Fweb.mjs`,
  ]) {
    expect(
      webExtensionRuntimeSnapshotSchema.safeParse({
        revision,
        extensions: [{ ...entry, entryUrl }],
      }).success,
    ).toBe(false);
  }
  expect(
    webExtensionsRpcSchemas[WEB_EXTENSIONS_RPC.backendInvoke].params.safeParse({
      id: "sample",
      method: "ping",
    }).success,
  ).toBe(false);
});

it("parses catalog rows independently, keeping the first valid row for each ID", () => {
  const row = {
    id: "sample",
    version: "1",
    name: { en: "Sample", "zh-CN": "示例" },
    description: { en: "Sample", "zh-CN": "示例" },
    author: "author",
    repository: "https://github.com/owner/repo",
    downloadUrl: "https://github.com/owner/repo/releases/download/v1/sample.zip",
    sha256: digest,
    format: "codexhost",
    targets: ["web"],
    apis: { web: 1 },
    futureField: "allowed",
  };
  const catalog = parseExtensionCatalogV2({
    schemaVersion: 2,
    generatedAt: "2026-01-01",
    futureField: true,
    extensions: [
      { ...row, downloadUrl: "bad url" },
      row,
      row,
      { ...row, id: "desktop", targets: ["desktop"], apis: { desktop: 1 } },
    ],
  });
  expect(catalog.extensions.map(({ id }) => id)).toEqual(["sample", "desktop"]);
  expect(catalog.skipped.map(({ index }) => index)).toEqual([0, 2]);
});
