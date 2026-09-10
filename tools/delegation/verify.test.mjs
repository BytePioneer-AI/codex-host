import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { listScenarioIds } from "./matrix.mjs";
import { runVerify } from "./verify.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const verifyPath = path.join(repositoryRoot, "tools/delegation/verify.mjs");

function run(args, env = process.env) {
  return spawnSync(process.execPath, [verifyPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env,
  });
}

describe("delegation verify entry", () => {
  it("ENTRY-01 lists unique scenarios and rejects invalid mode/scenario/output", async () => {
    const listed = run(["--list"]);
    expect(listed.status).toBe(0);
    const ids = listed.stdout.trim().split("\n");
    expect(ids).toEqual(listScenarioIds());
    expect(new Set(ids).size).toBe(ids.length);

    const invalidMode = run(["--mode", "fake", "--scenario", "ENTRY-01", "--output", os.tmpdir()]);
    expect(invalidMode.status).not.toBe(0);

    const invalidScenario = run([
      "--mode",
      "hermetic",
      "--scenario",
      "NOT-A-CASE",
      "--output",
      os.tmpdir(),
    ]);
    expect(invalidScenario.status).not.toBe(0);

    const unwritable = run([
      "--mode",
      "hermetic",
      "--scenario",
      "ENTRY-01",
      "--output",
      "/this/path/does/not/exist/and/cannot/be/created/verify-entry",
    ]);
    expect(unwritable.status).not.toBe(0);
  });

  it("ENTRY-02 does not target the inherited Desktop endpoint and redacts tokens", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "codexhost-verify-entry02-"));
    const inheritedEndpoint = "http://127.0.0.1:65530";
    const inheritedToken = "inherited-secret-token-value";
    const previousEndpoint = process.env.CODEXHOST_RUNTIME_ENDPOINT;
    const previousToken = process.env.CODEXHOST_RUNTIME_TOKEN;
    process.env.CODEXHOST_RUNTIME_ENDPOINT = inheritedEndpoint;
    process.env.CODEXHOST_RUNTIME_TOKEN = inheritedToken;
    try {
      const result = await runVerify([
        "--mode",
        "hermetic",
        "--scenario",
        "ENTRY-02",
        "--output",
        output,
      ]);
      expect(result.exitCode).toBe(0);
      const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
      expect(
        report.inheritedEndpoint === inheritedEndpoint || report.inheritedEndpoint === null,
      ).toBe(true);
      const json = JSON.stringify(report);
      expect(json).not.toContain(inheritedToken);
      expect(json).not.toMatch(/CODEXHOST_RUNTIME_TOKEN": "(?!\[redacted\])/u);
      if (report.scenarios[0]?.runtime?.endpoint) {
        expect(report.scenarios[0].runtime.endpoint).not.toBe(inheritedEndpoint);
      }
    } finally {
      if (previousEndpoint === undefined) delete process.env.CODEXHOST_RUNTIME_ENDPOINT;
      else process.env.CODEXHOST_RUNTIME_ENDPOINT = previousEndpoint;
      if (previousToken === undefined) delete process.env.CODEXHOST_RUNTIME_TOKEN;
      else process.env.CODEXHOST_RUNTIME_TOKEN = previousToken;
      await rm(output, { recursive: true, force: true });
    }
  });

  it("ENTRY-03 preserves scenario and cleanup failures and does not write the user repo", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "codexhost-verify-entry03-"));
    const leak = path.join(repositoryRoot, "entry-03-should-not-exist.txt");
    try {
      const result = await runVerify([
        "--mode",
        "hermetic",
        "--scenario",
        "ENTRY-03",
        "--output",
        output,
      ]);
      expect(result.exitCode).toBe(0);
      const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
      const details = report.scenarios[0]?.details;
      expect(details.scenarioError).toMatch(/synthetic scenario failure/u);
      expect(details.cleanupError).toMatch(/synthetic cleanup failure/u);
      await expect(readFile(leak, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(output, { recursive: true, force: true });
      await rm(leak, { force: true });
    }
  });
});
