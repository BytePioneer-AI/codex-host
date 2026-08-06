import { describe, expect, it } from "vitest";

import {
  updateCheckResultSchema,
  updateEmptyParamsSchema,
  updateStartResultSchema,
  updateStatusResultSchema,
  updateStatusSchema,
} from "@codexhost/shared-contracts";

const status = {
  version: "1.2.3",
  installation: "macos-dmg",
  phase: "waiting-for-exit",
  updatedAt: 1_753_000_000,
  error: null,
} as const;

describe("update runtime contracts", () => {
  it("accepts bounded check, start, and status results", () => {
    expect(
      updateCheckResultSchema.parse({
        currentVersion: "1.2.2",
        latestVersion: "1.2.3",
        updateAvailable: true,
        installationAvailable: true,
        releaseNotes: "## Changes\n\n- Safer updates",
        releaseNotesUrl: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.2.3",
        status: null,
        error: null,
      }),
    ).toMatchObject({ latestVersion: "1.2.3", updateAvailable: true });
    expect(updateStartResultSchema.parse({ status })).toEqual({ status });
    expect(updateStatusResultSchema.parse({ status })).toEqual({ status });
    expect(updateStatusResultSchema.parse({ status: null })).toEqual({ status: null });
  });

  it("requires empty strict params for every fixed operation", () => {
    expect(updateEmptyParamsSchema.parse({})).toEqual({});
    for (const privileged of [
      { url: "https://example.com/update.exe" },
      { version: "9.9.9" },
      { sha256: "ab".repeat(32) },
      { path: "/tmp/update" },
      { command: "npm install" },
      { target: "windows-x64" },
    ]) {
      expect(updateEmptyParamsSchema.safeParse(privileged).success).toBe(false);
    }
  });

  it("rejects unknown, unbounded, and non-GitHub data", () => {
    expect(updateStatusSchema.safeParse({ ...status, waitPid: 42 }).success).toBe(false);
    expect(updateStatusSchema.safeParse({ ...status, version: "1.2" }).success).toBe(false);
    expect(updateStatusSchema.safeParse({ ...status, error: "x".repeat(501) }).success).toBe(false);
    expect(
      updateCheckResultSchema.safeParse({
        currentVersion: "1.2.2",
        latestVersion: "1.2.3",
        updateAvailable: true,
        installationAvailable: true,
        releaseNotes: null,
        releaseNotesUrl: "https://example.com/releases/tag/v1.2.3",
        status: null,
        error: null,
      }).success,
    ).toBe(false);
    expect(
      updateCheckResultSchema.safeParse({
        currentVersion: "1.2.2",
        latestVersion: "1.2.3",
        updateAvailable: true,
        installationAvailable: true,
        releaseNotes: null,
        releaseNotesUrl: "https://github.com/Other/codex-host/releases/tag/v1.2.3",
        status: null,
        error: null,
      }).success,
    ).toBe(false);
    expect(
      updateCheckResultSchema.safeParse({
        currentVersion: "1.2.2",
        latestVersion: "1.2.3",
        updateAvailable: true,
        installationAvailable: true,
        releaseNotes: "x".repeat(20_001),
        releaseNotesUrl: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.2.3",
        status: null,
        error: null,
      }).success,
    ).toBe(false);
  });
});
