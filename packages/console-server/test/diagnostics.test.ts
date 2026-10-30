import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isLogFileName,
  listLogFiles,
  readControllerStatus,
  readLogTail,
  readStartupRecords,
  summarize,
  type ControllerStatus,
  type StartupRecord,
} from "../src/diagnostics.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-console-diagnostics-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const failedStartup: StartupRecord = {
  id: "1-2",
  pid: 2,
  launcherVersion: "0.10.2",
  startedAtMs: 1,
  finishedAtMs: 2,
  outcome: "failed",
  error: "Desktop Controller did not become ready before timeout",
  stages: [{ name: "launch requested", elapsedMs: 0 }],
  desktop: { version: "26.924.20706", build: "11431", installRoot: "/Applications/ChatGPT.app" },
};

const unavailableController: ControllerStatus = {
  pid: 9,
  startedAt: 1,
  renderer: {
    state: "unavailable",
    error: "Production Renderer Adapter is unsupported",
    failures: 2,
    lastError: "Production Renderer Adapter is unsupported",
    lastFailedAt: 3,
    lastInstalledAt: null,
    updatedAt: 3,
  },
};

describe("console diagnostics", () => {
  it("reads Launcher startup records and skips malformed entries", async () => {
    const filePath = path.join(directory, "launcher-startup-v1.json");
    await writeFile(
      filePath,
      JSON.stringify({ schemaVersion: 1, records: [failedStartup, { id: 3 }] }),
    );
    expect(await readStartupRecords(filePath)).toEqual([failedStartup]);
    expect(await readStartupRecords(path.join(directory, "missing.json"))).toEqual([]);
  });

  it("reads an unfinished startup alongside completed records", async () => {
    const filePath = path.join(directory, "launcher-startup-v1.json");
    const starting = { ...failedStartup, outcome: "starting", finishedAtMs: null, error: null };
    await writeFile(
      filePath,
      JSON.stringify({ schemaVersion: 1, records: [starting, failedStartup] }),
    );
    expect(await readStartupRecords(filePath)).toEqual([starting, failedStartup]);
  });

  it("reports a live unfinished launch as starting, not stopped or an old integration failure", () => {
    const input = {
      running: false,
      desktopError: null,
      latestStartup: {
        ...failedStartup,
        outcome: "starting" as const,
        finishedAtMs: null,
        error: null,
      },
      launcherAlive: true,
      controller: unavailableController,
      controllerAlive: true,
    };
    expect(summarize(input)).toEqual({ state: "starting", detail: null });
    expect(summarize({ ...input, running: true }).state).toBe("starting");
    expect(summarize({ ...input, launcherAlive: false }).state).toBe("startup-failed");
  });

  it("reads the Desktop Controller status document", async () => {
    const filePath = path.join(directory, "desktop-controller-v1.json");
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, ...unavailableController }));
    expect(await readControllerStatus(filePath)).toEqual(unavailableController);
    await writeFile(filePath, JSON.stringify({ schemaVersion: 2, ...unavailableController }));
    expect(await readControllerStatus(filePath)).toBeNull();
  });

  it("lists only Host Runtime logs and reads a line-aligned tail", async () => {
    const logs = path.join(directory, "logs");
    await mkdir(logs);
    await writeFile(path.join(logs, "host-runtime-12.log"), "first line\nsecond line\nthird\n");
    await writeFile(path.join(logs, "other.log"), "ignored");
    expect((await listLogFiles(logs)).map((entry) => entry.name)).toEqual(["host-runtime-12.log"]);
    expect(await readLogTail(logs, "host-runtime-12.log", 14)).toBe("third\n");
    expect(await readLogTail(logs, "../secret", 10)).toBeNull();
    expect(isLogFileName("host-runtime-12.log.1")).toBe(true);
    expect(isLogFileName("host-runtime-12.log/../../x")).toBe(false);
  });

  it("reports missing codexhost UI while Desktop keeps running", () => {
    expect(
      summarize({
        running: true,
        desktopError: null,
        latestStartup: null,
        controller: unavailableController,
        controllerAlive: true,
      }),
    ).toEqual({
      state: "integration-unavailable",
      detail: "Production Renderer Adapter is unsupported",
    });
  });

  it("does not report a single early failure that the Controller will retry", () => {
    const firstFailure = {
      ...unavailableController,
      renderer: { ...unavailableController.renderer, failures: 1, updatedAt: 1_000 },
    };
    const input = {
      running: true,
      desktopError: null,
      latestStartup: null,
      controller: firstFailure,
      controllerAlive: true,
    };
    expect(summarize({ ...input, now: 1_000 + 30_000 }).state).toBe("running");
    expect(summarize({ ...input, now: 1_000 + 60_000 }).state).toBe("integration-unavailable");
  });

  it("ignores a stale Controller status from an exited process", () => {
    expect(
      summarize({
        running: true,
        desktopError: null,
        latestStartup: null,
        controller: unavailableController,
        controllerAlive: false,
      }).state,
    ).toBe("running");
  });

  it("prefers a missing Desktop over an older failure when stopped", () => {
    expect(
      summarize({
        running: false,
        desktopError: "Codex Desktop was not found",
        latestStartup: failedStartup,
        controller: null,
        controllerAlive: false,
      }).state,
    ).toBe("desktop-missing");
    expect(
      summarize({
        running: false,
        desktopError: null,
        latestStartup: failedStartup,
        controller: null,
        controllerAlive: false,
      }),
    ).toEqual({ state: "startup-failed", detail: failedStartup.error });
  });
});
