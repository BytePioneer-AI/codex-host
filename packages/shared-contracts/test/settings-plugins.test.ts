import { expect, it } from "vitest";
import {
  settingsPluginManifestSchema,
  settingsPluginListResultSchema,
  settingsPluginReadParamsSchema,
} from "../src/settings-plugins.js";

const page = { id: "overview", title: "Example", icon: "🧩", entry: "index.html" };
it("rejects duplicate navigation registrations across the RPC boundary", () => {
  const registration = { pluginId: "example-page", id: "overview", title: "Example", icon: "🧩" };
  expect(
    settingsPluginListResultSchema.safeParse({
      pages: [registration, registration],
      unavailable: [],
    }).success,
  ).toBe(false);
});
const manifest = {
  manifestVersion: 1,
  id: "example-page",
  name: "Example",
  version: "1.0.0",
  pages: [page],
};
it("accepts data-only page registration and rejects unsafe resources and malformed identities", () => {
  expect(settingsPluginManifestSchema.parse(manifest)).toEqual(manifest);
  for (const entry of [
    "../index.html",
    "a/../../index.html",
    "/index.html",
    "https://example.com/index.html",
    "file:///index.html",
    "a\\index.html",
    "index.js",
  ]) {
    expect(
      settingsPluginManifestSchema.safeParse({ ...manifest, pages: [{ ...page, entry }] }).success,
    ).toBe(false);
  }
  for (const input of [
    { ...manifest, manifestVersion: 2 },
    { ...manifest, pages: [page, page] },
    { ...manifest, script: "test" },
    { ...manifest, pages: [{ ...page, icon: "" }] },
    { ...manifest, pages: [] },
  ]) {
    expect(settingsPluginManifestSchema.safeParse(input).success).toBe(false);
  }
  expect(
    settingsPluginReadParamsSchema.safeParse({ pluginId: "../other", pageId: "overview" }).success,
  ).toBe(false);
  expect(
    settingsPluginReadParamsSchema.safeParse({ pluginId: "example", pageId: "../../secret" })
      .success,
  ).toBe(false);
});
