import { expect, it } from "vitest";
import { testBinaries } from "./run.mjs";
it("selects actual native bin test executables without integration or start-menu binaries", () => {
  const artifact = (name, kind, executable) =>
    JSON.stringify({
      reason: "compiler-artifact",
      profile: { test: true },
      target: { name, kind: [kind] },
      executable,
    });
  const output = [
    artifact("codexhost-start", "bin", "start"),
    artifact("cli", "test", "integration"),
    artifact("codexhost", "bin", "launcher"),
    artifact("codexhost-updater", "bin", "updater"),
  ].join("\n");
  expect(testBinaries(output)).toEqual({ launcher: "launcher", updater: "updater" });
  expect(() => testBinaries("{}")).toThrow("missing native test binary");
});
