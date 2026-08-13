import { describe, expect, it } from "vitest";

import {
  NODE_VERSION,
  RELEASE_TARGETS,
  installerReleaseTargets,
  parseReleaseArguments,
  releaseTarget,
  releaseTargetForHost,
  releaseUsage,
  supportedReleaseTargets,
} from "../../scripts/release/targets.mjs";

const expectedTargets = ["macos-arm64", "macos-x64", "windows-x64", "windows-arm64", "linux-x64"];

describe("release targets", () => {
  it("defines the complete release target matrix", () => {
    expect(supportedReleaseTargets()).toEqual(expectedTargets);
    expect(installerReleaseTargets()).toEqual(
      expectedTargets.filter((target) => target !== "linux-x64"),
    );
    expect(NODE_VERSION).toBe("24.13.1");
    expect(Object.values(RELEASE_TARGETS).map((target) => target.rustTarget)).toEqual([
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
      "x86_64-pc-windows-msvc",
      "aarch64-pc-windows-msvc",
      "x86_64-unknown-linux-gnu",
    ]);
    expect(Object.values(RELEASE_TARGETS).map((target) => target.installerArchitecture)).toEqual([
      "arm64",
      "x64",
      "x64",
      "arm64",
      undefined,
    ]);
    for (const target of Object.values(RELEASE_TARGETS)) {
      if (target.packageArchitecture !== undefined) {
        expect(target.packageArchitecture).toBe("x64");
        expect(target.nodeArchive).toBeUndefined();
        expect(target.nodeArchiveSha256).toBeUndefined();
      } else {
        expect(target.nodeArchive).toContain(NODE_VERSION);
        expect(target.nodeArchiveSha256).toMatch(/^[0-9a-f]{64}$/u);
      }
    }
  });

  it("rejects unknown and cross-operating-system targets", () => {
    expect(() => releaseTarget("freebsd-x64")).toThrow("expected one of");
    expect(() => releaseTargetForHost("windows-x64", "darwin")).toThrow(
      "requires host platform 'win32'",
    );
    expect(() => releaseTargetForHost("macos-arm64", "win32")).toThrow(
      "requires host platform 'darwin'",
    );
  });

  it("parses one target and supports help", () => {
    expect(parseReleaseArguments(["--target", "macos-arm64"], "darwin")).toMatchObject({
      help: false,
      target: { id: "macos-arm64" },
    });
    expect(parseReleaseArguments(["--target=windows-arm64"], "win32")).toMatchObject({
      help: false,
      target: { id: "windows-arm64" },
    });
    expect(parseReleaseArguments(["--help"], "darwin")).toEqual({ help: true });
    expect(releaseUsage()).toContain("release:package");
  });

  it("rejects missing, duplicate, and unknown CLI options", () => {
    expect(() => parseReleaseArguments([], "darwin")).toThrow("--target is required");
    expect(() =>
      parseReleaseArguments(["--target", "macos-arm64", "--target", "macos-x64"], "darwin"),
    ).toThrow("may only be provided once");
    expect(() => parseReleaseArguments(["--output", "build"], "darwin")).toThrow(
      "unknown release option",
    );
    expect(() => parseReleaseArguments(["--target", "linux-x64"], "linux")).toThrow(
      "has no installer",
    );
  });
});
