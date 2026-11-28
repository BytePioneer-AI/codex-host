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
        installation: "macos-dmg",
        latestVersion: "1.2.3",
        updateAvailable: true,
        installationAvailable: true,
        releaseNotes: "## Changes\n\n- Safer updates",
        releaseNotesUrl: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.2.3",
        status: null,
        error: null,
        futureOptionalField: true,
      }),
    ).toMatchObject({
      installation: "macos-dmg",
      latestVersion: "1.2.3",
      updateAvailable: true,
    });
    expect(
      updateCheckResultSchema.parse({
        currentVersion: "1.2.2",
        installation: "macos-dmg",
        latestVersion: "1.2.3",
        updateAvailable: true,
        installationAvailable: true,
        releaseNotes: null,
        releaseNotesUrl: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.2.3",
        status: null,
        error: null,
        stagedVersion: "1.2.3",
        backgroundPhase: "ready",
        backgroundDownload: null,
        backgroundError: null,
        runningTaskCount: 2,
      }),
    ).toMatchObject({
      stagedVersion: "1.2.3",
      backgroundPhase: "ready",
      runningTaskCount: 2,
    });
    expect(
      updateCheckResultSchema.parse({
        currentVersion: "1.2.2",
        installation: "macos-dmg",
        latestVersion: "1.2.3",
        updateAvailable: true,
        installationAvailable: true,
        releaseNotes: null,
        releaseNotesUrl: null,
        status: null,
        error: null,
        stagedVersion: null,
        backgroundPhase: "downloading",
        backgroundDownload: { downloadedBytes: 10, totalBytes: 100 },
        backgroundError: null,
        runningTaskCount: 0,
      }),
    ).toMatchObject({
      backgroundPhase: "downloading",
      backgroundDownload: { downloadedBytes: 10, totalBytes: 100 },
    });
    expect(updateStartResultSchema.parse({ status })).toEqual({ status });
    expect(updateStatusResultSchema.parse({ status })).toEqual({ status });
    expect(updateStatusResultSchema.parse({ status: null })).toEqual({ status: null });
  });

  it("rejects invalid background staging fields and negative running task counts", () => {
    const base = {
      currentVersion: "1.2.2",
      installation: "macos-dmg" as const,
      latestVersion: "1.2.3",
      updateAvailable: true,
      installationAvailable: true,
      releaseNotes: null,
      releaseNotesUrl: null,
      status: null,
      error: null,
    };
    expect(
      updateCheckResultSchema.safeParse({
        ...base,
        backgroundPhase: "downloading",
        backgroundDownload: { downloadedBytes: 101, totalBytes: 100 },
      }).success,
    ).toBe(false);
    expect(
      updateCheckResultSchema.safeParse({
        ...base,
        backgroundPhase: "failed",
        backgroundError: "x".repeat(501),
      }).success,
    ).toBe(false);
    expect(
      updateCheckResultSchema.safeParse({
        ...base,
        stagedVersion: "not-a-semver",
      }).success,
    ).toBe(false);
    expect(
      updateCheckResultSchema.safeParse({
        ...base,
        runningTaskCount: -1,
      }).success,
    ).toBe(false);
  });

  it("preserves optional service stop output without interpreting tasks", () => {
    const serviceStopOutput = "Host stopped; interrupted 7 running task(s)\n";
    expect(updateStatusSchema.parse({ ...status, serviceStopOutput }).serviceStopOutput).toBe(
      serviceStopOutput,
    );
    expect(updateStatusSchema.safeParse({ ...status, serviceStopOutput: 7 }).success).toBe(false);
  });

  it("accepts bounded download progress and rejects impossible byte counts", () => {
    expect(
      updateStatusSchema.parse({
        ...status,
        phase: "downloading",
        downloadedBytes: 42,
        totalBytes: 100,
      }),
    ).toMatchObject({ downloadedBytes: 42, totalBytes: 100 });
    expect(
      updateStatusSchema.safeParse({
        ...status,
        phase: "downloading",
        downloadedBytes: 101,
        totalBytes: 100,
      }).success,
    ).toBe(false);
  });

  it("accepts npm package progress and rejects a count above the total", () => {
    const downloading = { ...status, installation: "npm", phase: "downloading" };
    expect(
      updateStatusSchema.parse({ ...downloading, npmDownload: { completed: 1, total: 2 } }),
    ).toMatchObject({ npmDownload: { completed: 1, total: 2 } });
    expect(
      updateStatusSchema.safeParse({ ...downloading, npmDownload: { completed: 3, total: 2 } })
        .success,
    ).toBe(false);
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
        installation: "windows-installer",
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
        installation: "npm",
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
        installation: "npm",
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
