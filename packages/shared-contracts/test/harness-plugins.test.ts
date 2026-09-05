import { describe, expect, it } from "vitest";

import {
  HARNESS_PLUGIN_ROUTE_PREFIX,
  decodeHarnessPluginRoute,
  encodeHarnessPluginRoute,
  harnessPluginConfigurationSchema,
  harnessPluginManifestSchema,
  harnessPluginRouteSchema,
} from "../src/index.js";

const manifest = {
  manifestVersion: 1,
  id: "sample-agent",
  name: "Sample Agent",
  version: "1.0.0",
  adapterApiVersion: 1,
  entry: "dist/plugin.js",
};

describe("Harness plugin public contracts", () => {
  it("accepts an arbitrary portable external identity and a future API version as data", () => {
    expect(harnessPluginManifestSchema.parse({ ...manifest, adapterApiVersion: 2 }).id).toBe(
      "sample-agent",
    );
  });

  it.each(["codex", "../agent", "UPPER", "", "a/b", "a..b"])("rejects identity %j", (id) => {
    expect(harnessPluginManifestSchema.safeParse({ ...manifest, id }).success).toBe(false);
  });

  it.each([
    "../plugin.js",
    "/plugin.js",
    "C:\\plugin.js",
    "dist/../../plugin.js",
    "file:plugin.js",
    "a//b.js",
    "a.js#fragment",
    "a.js?query",
  ])("rejects resource %j", (entry) => {
    expect(harnessPluginManifestSchema.safeParse({ ...manifest, entry }).success).toBe(false);
  });

  it.each([
    "javascript:alert(1)",
    "file:///private/file",
    "http://example.com",
    "https://user:secret@example.com",
  ])("rejects documentation link %j", (documentation) => {
    expect(
      harnessPluginManifestSchema.safeParse({ ...manifest, links: { documentation } }).success,
    ).toBe(false);
  });

  it("rejects duplicate enablement and backend data in the public manifest", () => {
    expect(
      harnessPluginConfigurationSchema.safeParse({
        version: 1,
        enabled: ["sample-agent", "sample-agent"],
      }).success,
    ).toBe(false);
    expect(harnessPluginManifestSchema.safeParse({ ...manifest, apiKey: "secret" }).success).toBe(
      false,
    );
  });
});

describe("versioned browser-safe Harness route", () => {
  it("round trips identity and every configuration field without any Harness-specific codec", () => {
    const route = harnessPluginRouteSchema.parse({
      harnessId: "unknown.plugin",
      model: { id: "opaque-model_1" },
      thinkingOptionId: "high",
      permissionModeId: "ask-first",
    });
    expect(decodeHarnessPluginRoute(encodeHarnessPluginRoute(route))).toEqual(route);
    const minimal = harnessPluginRouteSchema.parse({ harnessId: "unknown.plugin" });
    expect(decodeHarnessPluginRoute(encodeHarnessPluginRoute(minimal))).toEqual(minimal);
  });

  it.each([undefined, null, 1, "gpt-5", "codexhost/pi-native"])(
    "leaves other protocols untouched (%j)",
    (value) => {
      expect(decodeHarnessPluginRoute(value)).toBeNull();
    },
  );

  it.each(["", "xx", "7", "7B7D", "00", "7b7d", "00".repeat(4096)])(
    "rejects malformed owned route case %#",
    (payload) => {
      expect(() => decodeHarnessPluginRoute(HARNESS_PLUGIN_ROUTE_PREFIX + payload)).toThrow(
        "Invalid Harness plugin route",
      );
    },
  );

  it("rejects reordered, extra, or noncanonical JSON instead of passing it to Codex", () => {
    for (const json of [
      '{ "harnessId": "sample-agent" }',
      '{"harnessId":"sample-agent","extra":true}',
      '{"harnessId":"codex"}',
      '{"harnessId":"sample-agent","harnessId":"other-agent"}',
    ]) {
      const payload = [...json]
        .map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("");
      expect(() => decodeHarnessPluginRoute(HARNESS_PLUGIN_ROUTE_PREFIX + payload)).toThrow(
        "Invalid Harness plugin route",
      );
    }
  });
});
