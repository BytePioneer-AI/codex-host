import { describe, expect, it } from "vitest";
import { findReviewedDesktop, parseReviewedDesktopManifest } from "./reviewed-desktops.mjs";

const identity = {
  platform: "macos",
  version: "26.825.41651",
  build: "7345",
  asarIntegrity:
    "sha256:c089b63abb7ca4a751072c0da434248db13c32bed9c363e1b7e5428584b0576d",
};

const parse = (entry = {}) =>
  parseReviewedDesktopManifest(
    { schemaVersion: 1, desktops: [{ ...identity, baseline: "baselines/macos.json", ...entry }] },
    "/repo/audit",
  );

describe("reviewed desktop manifest", () => {
  it("parses and finds an exact identity", () => {
    const manifest = parse();
    expect(findReviewedDesktop(manifest, identity)).toMatchObject(identity);
    expect(manifest.desktops[0].baseline).toBe("/repo/audit/baselines/macos.json");
  });

  it("rejects an identity mismatch as not reviewed", () => {
    expect(() => findReviewedDesktop(parse(), { ...identity, build: "7346" })).toThrow(
      "not reviewed",
    );
  });

  it("rejects malformed manifests", () => {
    expect(() => parse({ asarIntegrity: "sha256:ABC" })).toThrow();
    expect(() => parse({ platform: "" })).toThrow();
    expect(() => parseReviewedDesktopManifest({ schemaVersion: 2, desktops: [] }, "/repo/audit")).toThrow();
    expect(() => parseReviewedDesktopManifest({ schemaVersion: 1, desktops: [] }, "/repo/audit")).toThrow();
  });

  it("rejects duplicate compound identities", () => {
    expect(() =>
      parseReviewedDesktopManifest(
        { schemaVersion: 1, desktops: [{ ...identity, baseline: "a" }, { ...identity, baseline: "b" }] },
        "/repo/audit",
      ),
    ).toThrow(/duplicate/i);
  });

  it.each(["../outside.json", "/tmp/outside.json"])('rejects escaping baseline "%s"', (baseline) => {
    expect(() => parse({ baseline })).toThrow(/baseline|confined|path/i);
  });
});
