import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createRendererStatusReporter,
  defaultControllerStatusPath,
  writeControllerStatusFile,
} from "../src/controller-status.js";

describe("Desktop Controller status", () => {
  it("publishes only state changes", () => {
    const publish = vi.fn();
    const reporter = createRendererStatusReporter(publish, () => 10, 42);

    reporter.installing();
    reporter.installed();
    reporter.installed();
    reporter.installed();

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[0]).toEqual({
      schemaVersion: 1,
      pid: 42,
      startedAt: 10,
      renderer: {
        state: "installed",
        error: null,
        failures: 0,
        lastError: null,
        lastFailedAt: null,
        lastInstalledAt: 10,
        updatedAt: 10,
      },
    });
  });

  it("keeps the failure chain and counts repeated failures", () => {
    const publish = vi.fn();
    const reporter = createRendererStatusReporter(publish, () => 1, 1);

    reporter.failed(new Error("install failed", { cause: new Error("signature-mismatch") }));
    reporter.failed(new Error("install failed", { cause: new Error("signature-mismatch") }));

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[0].renderer).toMatchObject({
      state: "unavailable",
      error: "install failed: signature-mismatch",
      failures: 2,
    });
  });

  it("resolves the status file under the codexhost data directory", () => {
    const dataDirectory = path.resolve("/data/codexhost");
    expect(defaultControllerStatusPath({ CODEXHOST_DATA_DIR: dataDirectory })).toBe(
      path.join(dataDirectory, "diagnostics", "desktop-controller-v1.json"),
    );
  });

  it("writes the status document atomically", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-controller-status-"));
    try {
      const filePath = path.join(directory, "diagnostics", "desktop-controller-v1.json");
      const document = {
        schemaVersion: 1 as const,
        pid: 7,
        startedAt: 1,
        renderer: {
          state: "installed" as const,
          error: null,
          failures: 0,
          lastError: null,
          lastFailedAt: null,
          lastInstalledAt: 1,
          updatedAt: 1,
        },
      };
      await writeControllerStatusFile(filePath, document);
      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(document);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
