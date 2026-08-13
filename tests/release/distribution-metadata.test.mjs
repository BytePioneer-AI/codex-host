import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDistributionMetadata,
  writeDistributionMetadata,
} from "../../scripts/release/distribution-metadata.mjs";

describe("release distribution metadata", () => {
  it("records the exact release version, channel, and target", async () => {
    expect(
      createDistributionMetadata({
        version: "1.2.3-test.4",
        distribution: "npm",
        target: "windows-arm64",
      }),
    ).toEqual({
      schemaVersion: 1,
      version: "1.2.3-test.4",
      distribution: "npm",
      target: "windows-arm64",
    });

    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-distribution-"));
    const output = path.join(root, "codexhost-distribution.json");
    try {
      await writeDistributionMetadata(output, {
        version: "1.2.3",
        distribution: "installer",
        target: "macos-arm64",
      });
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
        schemaVersion: 1,
        version: "1.2.3",
        distribution: "installer",
        target: "macos-arm64",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed release metadata", () => {
    expect(() =>
      createDistributionMetadata({
        version: "latest",
        distribution: "installer",
        target: "macos-arm64",
      }),
    ).toThrow("valid semver");
    expect(() =>
      createDistributionMetadata({
        version: "1.2.3",
        distribution: "archive",
        target: "macos-arm64",
      }),
    ).toThrow("installer or npm");
    expect(
      createDistributionMetadata({
        version: "1.2.3",
        distribution: "npm",
        target: "linux-x64",
      }),
    ).toMatchObject({ target: "linux-x64" });
    expect(() =>
      createDistributionMetadata({
        version: "1.2.3",
        distribution: "npm",
        target: "linux-arm64",
      }),
    ).toThrow("target is invalid");
  });
});
