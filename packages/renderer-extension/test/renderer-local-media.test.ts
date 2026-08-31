import { describe, expect, it } from "vitest";

import {
  absoluteLocalVideoPath,
  codexAppFsMediaUrl,
  isLocalVideoPath,
} from "../src/renderer-local-media.js";

describe("Renderer local video URLs", () => {
  it("accepts absolute POSIX, file, and app://fs video paths", () => {
    const absolute = "/Users/chris/Downloads/usegrokbot-templates-promo-10s.mp4";
    expect(isLocalVideoPath(absolute)).toBe(true);
    expect(absoluteLocalVideoPath(`file://${absolute}`)).toBe(absolute);
    expect(absoluteLocalVideoPath(codexAppFsMediaUrl(absolute))).toBe(absolute);
  });

  it("rejects remote URLs, relative paths, and non-video files", () => {
    expect(isLocalVideoPath("videos/1.mp4")).toBe(false);
    expect(isLocalVideoPath("https://example.com/a.mp4")).toBe(false);
    expect(isLocalVideoPath("/Users/chris/Downloads/photo.png")).toBe(false);
    expect(isLocalVideoPath("/Users/chris/../etc/passwd.mp4")).toBe(false);
  });

  it("builds the Codex app://fs media URL Desktop already streams", () => {
    expect(codexAppFsMediaUrl("/Users/chris/Downloads/clip.mp4")).toBe(
      "app://fs/@fs/Users/chris/Downloads/clip.mp4",
    );
  });
});
