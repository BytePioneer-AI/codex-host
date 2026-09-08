import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveMuseExecutable } from "../src/command.js";
import { MUSE_MSP_NOTIFICATIONS, MUSE_MSP_REQUEST_METHODS } from "../src/msp-surface.js";

describe("muse MSP surface", () => {
  it("only uses methods and notifications present on this muse binary", () => {
    const executable = resolveMuseExecutable({ environment: process.env });
    if (!executable) return;
    const out = mkdtempSync(path.join(tmpdir(), "muse-schema-"));
    execFileSync(executable, ["schema", "generate-json-schema", "--out", out], {
      encoding: "utf8",
    });
    const schema = JSON.parse(readFileSync(path.join(out, "msp.schema.json"), "utf8")) as {
      methods?: Record<string, unknown>;
      notifications?: Record<string, unknown>;
    };
    const methods = Object.keys(schema.methods ?? {});
    const notifications = Object.keys(schema.notifications ?? {});
    expect(methods).toEqual(expect.arrayContaining([...MUSE_MSP_REQUEST_METHODS]));
    expect(notifications).toEqual(expect.arrayContaining([...MUSE_MSP_NOTIFICATIONS]));
  });
});
