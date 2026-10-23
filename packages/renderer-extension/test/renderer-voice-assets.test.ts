import { describe, expect, it } from "vitest";
import { CLIENT_OWNED_VOICE_ASSETS } from "../src/renderer-client-owned-voice.js";
import { selectVoiceAssets, supportsVoiceVersion } from "../src/renderer-voice-assets.js";

const latest = ["app-initial-dddef47d6ef6.js", "app-shared-fc3316d48427.js"];
const baseline = ["app-initial-c95ddb62696e.js", "app-shared-2eda13eb7044.js"];
const urls = (assets: string[]) => assets.map((asset) => `app://-/assets/${asset}`);

describe("audited voice asset ownership", () => {
  it.each([
    ["26.1016.62342", latest, "avatar-overlay-native-page-ef8332c6a2fb.js"],
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
    ["26.1016.62342", baseline],
    ["26.1016.61520", latest],
    ["unknown", latest],
    [undefined, [latest[0], baseline[1]]],
    [undefined, [...latest, ...baseline]],
    ["26.1016.62342", [...latest, baseline[0]]],
    [undefined, [latest[0]]],
  ])("rejects incomplete, mixed, ambiguous or mismatched bindings (%s, %j)", (version, assets) => {
    expect(
      selectVoiceAssets(CLIENT_OWNED_VOICE_ASSETS, urls(assets as string[]), version),
    ).toBeUndefined();
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
    expect(supportsVoiceVersion(CLIENT_OWNED_VOICE_ASSETS, "26.1016.62343")).toBe(false);
  });
});
