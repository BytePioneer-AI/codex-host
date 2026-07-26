import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const runner = path.resolve(import.meta.dirname, "run.mjs");

describe("Gate C report entrypoint", () => {
  it("refuses to combine independently captured profile runs", () => {
    const result = spawnSync(process.execPath, [runner, "finalize"], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no longer combines independent profile runs");
  });
});
