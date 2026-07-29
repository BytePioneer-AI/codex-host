import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const runner = path.resolve(import.meta.dirname, "run.mjs");

describe("Claude Probe runner profiles", () => {
  it("does not import live code for the Hermetic profile", () => {
    const result = spawnSync(process.execPath, [runner, "hermetic"], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      encoding: "utf8",
      env: { ...process.env, CODEXHOST_CLAUDE_LIVE: "" },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("may use network/model quota");
  });

  it("rejects unknown profiles", () => {
    const result = spawnSync(process.execPath, [runner, "unknown"], {
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown Claude Probe command");
  });
});
