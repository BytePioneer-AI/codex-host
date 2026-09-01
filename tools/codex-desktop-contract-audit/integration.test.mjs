import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runReviewedDesktopIntegration } from "./integration.mjs";
import { AUDIT_SURFACE_IDS } from "./report.mjs";
import { parseReviewedDesktopManifest } from "./reviewed-desktops.mjs";

const identity = {
  platform: "macos",
  version: "26.825.41651",
  build: "7345",
  asarIntegrity: "sha256:c089b63abb7ca4a751072c0da434248db13c32bed9c363e1b7e5428584b0576d",
};

const temporaryDirectories = [];

function baselineReport() {
  return {
    schemaVersion: 1,
    recordedAt: "2026-09-01T00:00:00.000Z",
    mode: "controlled",
    verdict: "no-impact",
    desktop: identity,
    browser: { browser: "Chrome/151", protocolVersion: "1.3" },
    checksRun: ["controlled-production-installation"],
    baseline: { supplied: false, version: null, build: null },
    surfaces: AUDIT_SURFACE_IDS.map((id) => ({
      id,
      verdict: "no-impact",
      reason: "reviewed-contract",
      evidence: {
        static: "pass",
        liveStructure: "pass",
        installation: "pass",
        behavior: "not-run",
      },
      observed: {},
      baselineChanged: false,
    })),
  };
}

function reviewedFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-integration-"));
  temporaryDirectories.push(directory);
  const baseline = path.join(directory, "baseline.json");
  fs.writeFileSync(baseline, `${JSON.stringify(baselineReport())}\n`);
  return {
    baseline,
    manifest: parseReviewedDesktopManifest(
      {
        schemaVersion: 1,
        desktops: [{ ...identity, baseline: "baseline.json" }],
      },
      directory,
    ),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("reviewed Codex Desktop integration", () => {
  it("runs a controlled audit with the exact reviewed baseline", async () => {
    const { baseline, manifest } = reviewedFixture();

    const result = await runReviewedDesktopIntegration({
      identity,
      manifest,
      runAudit: async (options) => {
        if (options.mode !== "controlled" || options.baselinePath !== fs.realpathSync(baseline)) {
          throw new Error("audit did not receive the reviewed baseline");
        }
        return { verdict: "no-impact", surfaces: [] };
      },
    });

    expect(result).toMatchObject({ verdict: "no-impact", unverifiedSurfaces: [] });
  });

  it("rejects an identity that is not exactly reviewed", async () => {
    const { manifest } = reviewedFixture();
    await expect(
      runReviewedDesktopIntegration({
        identity: { ...identity, build: "7346" },
        manifest,
        runAudit: async () => {
          throw new Error("audit must not run");
        },
      }),
    ).rejects.toThrow("not reviewed");
  });

  it("rejects a reviewed entry whose baseline is missing", async () => {
    const { baseline, manifest } = reviewedFixture();
    fs.rmSync(baseline);
    await expect(
      runReviewedDesktopIntegration({
        identity,
        manifest,
        runAudit: async () => {
          throw new Error("audit must not run");
        },
      }),
    ).rejects.toThrow(/baseline.*missing/i);
  });

  it("rejects a reviewed baseline symlink that escapes the manifest directory", async () => {
    const { baseline, manifest } = reviewedFixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-integration-outside-"));
    temporaryDirectories.push(outside);
    const outsideBaseline = path.join(outside, "baseline.json");
    fs.writeFileSync(outsideBaseline, `${JSON.stringify(baselineReport())}\n`);
    fs.rmSync(baseline);
    fs.symlinkSync(outsideBaseline, baseline);

    await expect(
      runReviewedDesktopIntegration({
        identity,
        manifest,
        runAudit: async () => ({ verdict: "no-impact", surfaces: [] }),
      }),
    ).rejects.toThrow(/baseline.*confined|symlink/i);
  });

  it("rejects a baseline for a different Desktop identity", async () => {
    const { baseline, manifest } = reviewedFixture();
    fs.writeFileSync(
      baseline,
      `${JSON.stringify({
        ...baselineReport(),
        desktop: { ...identity, build: "7000" },
      })}\n`,
    );
    await expect(
      runReviewedDesktopIntegration({
        identity,
        manifest,
        runAudit: async () => ({ verdict: "no-impact", surfaces: [] }),
      }),
    ).rejects.toThrow(/baseline.*identity.*match/i);
  });

  it.each(["possible-impact", "confirmed-impact"])(
    "rejects an audit verdict of %s",
    async (verdict) => {
      const { manifest } = reviewedFixture();
      await expect(
        runReviewedDesktopIntegration({
          identity,
          manifest,
          runAudit: async () => ({ verdict, surfaces: [] }),
        }),
      ).rejects.toThrow(verdict);
    },
  );

  it("returns the exact unverified surface ids as warnings", async () => {
    const { manifest } = reviewedFixture();
    const result = await runReviewedDesktopIntegration({
      identity,
      manifest,
      runAudit: async () => ({
        verdict: "unverified",
        surfaces: [
          { id: "composer", verdict: "no-impact" },
          { id: "permission", verdict: "unverified" },
          { id: "fork", verdict: "unverified" },
        ],
      }),
    });

    expect(result.unverifiedSurfaces).toEqual(["permission", "fork"]);
  });

  it("rejects a verdict outside the audit contract", async () => {
    const { manifest } = reviewedFixture();
    await expect(
      runReviewedDesktopIntegration({
        identity,
        manifest,
        runAudit: async () => ({ verdict: "maybe", surfaces: [] }),
      }),
    ).rejects.toThrow(/invalid.*verdict/i);
  });
});
