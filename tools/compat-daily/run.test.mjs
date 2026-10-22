import assert from "node:assert/strict";
import { evaluate, parseAppcast, readPins } from "./run.mjs";
import { describe, it } from "node:test";

const files = {
  clientOwned: `
export const CLIENT_OWNED_VOICE_VERSION = "26.1016.51333";
export const CLIENT_OWNED_VOICE_INITIAL_ASSET = "app-initial-f3e281fb9a71.js";
export const CLIENT_OWNED_VOICE_SHARED_ASSET = "app-shared-60f4bb85435f.js";
`,
  nativeChat: `
const NATIVE_CHAT_VOICE_VERSION = "26.1013.40934";
const NATIVE_CHAT_INITIAL_ASSET = "app-initial-90eb42395b7d.js";
const START_ASSET = "start-voice-954090654801.js";
`,
  voiceStart: `export const VOICE_START_OVERLAY_ASSET = "avatar-overlay-native-page-48cbc35fadc8.js";`,
};

describe("compat-daily pins", () => {
  it("reads Renderer voice pins from source", () => {
    assert.deepEqual(readPins(files), {
      workVersion: "26.1016.51333",
      workInitial: "app-initial-f3e281fb9a71.js",
      workShared: "app-shared-60f4bb85435f.js",
      overlayAsset: "avatar-overlay-native-page-48cbc35fadc8.js",
      chatVersion: "26.1013.40934",
      chatInitial: "app-initial-90eb42395b7d.js",
      chatStart: "start-voice-954090654801.js",
    });
  });

  it("parses the first Sparkle item", () => {
    const xml = `<?xml version="1.0"?>
<rss><channel>
<item>
  <sparkle:version>21421</sparkle:version>
  <sparkle:shortVersionString>26.1016.61520</sparkle:shortVersionString>
</item>
<item>
  <sparkle:shortVersionString>26.1016.51333</sparkle:shortVersionString>
</item>
</channel></rss>`;
    assert.deepEqual(parseAppcast(xml), { version: "26.1016.61520", build: "21421" });
  });

  it("reports Chat and Work when Sparkle is ahead of both pins", () => {
    const report = evaluate(readPins(files), { version: "26.1016.61520", build: "21421" });
    assert.equal(report.findings.length, 2);
    assert.equal(report.findings[0]?.surface, "work-voice");
    assert.equal(report.findings[1]?.surface, "chat-voice");
    assert.match(report.findings[1]?.title ?? "", /chat-voice/);
  });

  it("falls back Chat pins to Work when Chat reuses CLIENT_OWNED_*", () => {
    const pins = readPins({
      ...files,
      nativeChat: `const START_ASSET = "start-voice-954090654801.js";\n`,
      voiceStart: "",
    });
    assert.equal(pins.chatVersion, "26.1016.51333");
    assert.equal(pins.chatInitial, "app-initial-f3e281fb9a71.js");
    assert.equal(pins.overlayAsset, undefined);
  });

  it("is quiet when Sparkle matches both pins", () => {
    const matched = {
      ...files,
      nativeChat: files.nativeChat.replace("26.1013.40934", "26.1016.51333"),
    };
    const report = evaluate(readPins(matched), { version: "26.1016.51333", build: "21161" });
    assert.equal(report.findings.length, 0);
  });
});
