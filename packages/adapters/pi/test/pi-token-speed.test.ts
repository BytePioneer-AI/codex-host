import { describe, expect, it } from "vitest";
import { parsePiTokenSpeedStatus } from "../src/pi-token-speed.js";

const frame = (statusText?: unknown) => ({
  type: "extension_ui_request",
  method: "setStatus",
  statusKey: "tokenSpeed",
  statusText,
});

describe("pi-token-speed native status", () => {
  it("reads colored fractional rates with all display suffixes", () => {
    for (const suffix of [
      "\u200b",
      " (TTFT: 123 ms)",
      " (20 tok in 0.5s)",
      " (20 tok in 0.5s · TTFT: 123 ms)",
    ]) {
      expect(
        parsePiTokenSpeedStatus(
          frame("\x1b[2m⚡ TPS:\x1b[0m \x1b[38;2;10;20;30m42.7 tok/s\x1b[0m" + suffix),
        ),
      ).toEqual({ outputTokensPerSecond: 42.7 });
    }
    expect(parsePiTokenSpeedStatus(frame("TPS: 0.0 tok/s"))).toEqual({ outputTokensPerSecond: 0 });
  });
  it("treats native placeholders and retractions as absent speed, not zero", () => {
    for (const text of [undefined, "", "TPS: --"])
      expect(parsePiTokenSpeedStatus(frame(text))).toEqual({});
  });
  it("ignores unrelated extensions and malformed rates", () => {
    expect(parsePiTokenSpeedStatus({ ...frame("TPS: 42 tok/s"), statusKey: "other" })).toBeNull();
    for (const text of [
      null,
      42,
      "TPS: -1 tok/s",
      "TPS: NaN tok/s",
      "TPS: Infinity tok/s",
      "42 tok/s",
      "TPS: 42 tok/something",
    ]) {
      expect(parsePiTokenSpeedStatus(frame(text))).toBeNull();
    }
  });
});
