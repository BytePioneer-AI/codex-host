import { describe, expect, it } from "vitest";
import { CLIENT_OWNED_VOICE_ASSETS } from "../src/renderer-client-owned-voice.js";
import { selectVoiceAssets, supportsVoiceVersion } from "../src/renderer-voice-assets.js";

const latest = ["app-initial-feb30b196d11.js", "app-shared-2cae01273bae.js"] as const;
const windows = ["app-initial-438d1df57f70.js", "app-shared-955d52676f9c.js"] as const;
const previous = ["app-initial-dddef47d6ef6.js", "app-shared-fc3316d48427.js"] as const;
const baseline = ["app-initial-c95ddb62696e.js", "app-shared-2eda13eb7044.js"] as const;
const urls = (assets: readonly string[]) => assets.map((asset) => `app://-/assets/${asset}`);

describe("audited voice asset ownership", () => {
  it("requires platform metadata for an empty same-version asset set", () => {
    expect(selectVoiceAssets(CLIENT_OWNED_VOICE_ASSETS, [], "26.1021.31345")).toBeUndefined();
    expect(
      selectVoiceAssets(CLIENT_OWNED_VOICE_ASSETS, [], "26.1021.31345", "win32"),
    ).toMatchObject({ initial: windows[0] });
  });

  it("rejects mixed platform assets and contradictory platform metadata", () => {
    for (const names of [[latest[0], windows[1]], [...latest, ...windows], [windows[0]]])
      expect(
        selectVoiceAssets(CLIENT_OWNED_VOICE_ASSETS, urls(names), "26.1021.31345", "win32"),
      ).toBeUndefined();
    expect(
      selectVoiceAssets(CLIENT_OWNED_VOICE_ASSETS, urls(latest), "26.1021.31345", "win32"),
    ).toBeUndefined();
  });

  it.each([
    ["26.1021.31345", latest, "avatar-overlay-native-page-d549db3706f1.js"],
    ["26.1021.31345", windows, "avatar-overlay-native-page-1549fe5955e1.js"],
    ["26.1016.62342", previous, "avatar-overlay-native-page-ef8332c6a2fb.js"],
    ["26.1016.61520", baseline, "avatar-overlay-native-page-fcc17283519a.js"],
  ])(
    "selects the matching %s overlay with or without version metadata",
    (version, assets, overlay) => {
      for (const metadata of [version, undefined])
        expect(selectVoiceAssets(CLIENT_OWNED_VOICE_ASSETS, urls(assets), metadata)).toMatchObject({
          version,
          overlay,
        });
    },
  );

  it.each([
    ["26.1021.31345", previous],
    ["26.1016.62342", latest],
    ["26.1016.62342", baseline],
    ["26.1016.61520", latest],
    ["unknown", latest],
    [undefined, [latest[0], previous[1]]],
    [undefined, [...latest, ...previous]],
    ["26.1021.31345", [...latest, previous[0]]],
    [undefined, [latest[0]]],
  ])("rejects incomplete, mixed, ambiguous or mismatched bindings (%s, %j)", (version, assets) => {
    expect(selectVoiceAssets(CLIENT_OWNED_VOICE_ASSETS, urls(assets), version)).toBeUndefined();
  });

  it("selects the version pin when resource names are empty", () => {
    expect(
      selectVoiceAssets(CLIENT_OWNED_VOICE_ASSETS, [], "26.1021.31345", "darwin"),
    ).toMatchObject({
      version: "26.1021.31345",
      initial: "app-initial-feb30b196d11.js",
    });
    expect(selectVoiceAssets(CLIENT_OWNED_VOICE_ASSETS, [], undefined)).toBeUndefined();
  });

  it("rejects lookalike assets outside the native origin", () => {
    expect(
      selectVoiceAssets(
        CLIENT_OWNED_VOICE_ASSETS,
        latest.map((asset) => `https://example.com/assets/${asset}`),
      ),
    ).toBeUndefined();
    expect(
      selectVoiceAssets(
        CLIENT_OWNED_VOICE_ASSETS,
        latest.map((asset) => `app://other/assets/${asset}`),
      ),
    ).toBeUndefined();
    expect(supportsVoiceVersion(CLIENT_OWNED_VOICE_ASSETS, "26.1021.31346")).toBe(false);
  });
});
