import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GATE_C_SCHEMA_VERSION, gateReportSchema } from "./contracts.mjs";
import { GateCError } from "./errors.mjs";
import { assertLocalEvidencePath } from "./workspace.mjs";

export function overallStatus(scenarios) {
  const required = scenarios.filter(({ required }) => required);
  if (required.some(({ status }) => status === "FAIL")) return "FAIL";
  if (required.some(({ status }) => status === "BLOCKED")) return "BLOCKED";
  return "PASS";
}

export function repositoryCommit(repositoryRoot) {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (revision.status !== 0) return "unknown";
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return `${revision.stdout.trim()}${status.stdout.trim() ? "-dirty" : ""}`;
}

export function requireReproducibleCommit(repositoryRoot) {
  const revision = repositoryCommit(repositoryRoot);
  if (revision === "unknown" || revision.endsWith("-dirty")) {
    throw new GateCError(
      "EVIDENCE_SOURCE",
      "An authoritative Gate C report requires a clean Git worktree with a known commit",
    );
  }
  return revision;
}

export function writeGateReport(repositoryRoot, outputPath, input) {
  const safePath = assertLocalEvidencePath(repositoryRoot, outputPath);
  const status = overallStatus(input.scenarios);
  const report = gateReportSchema.parse({
    schemaVersion: GATE_C_SCHEMA_VERSION,
    gate: "pi-rpc-capabilities",
    status,
    recordedAt: new Date().toISOString(),
    repositoryCommit: repositoryCommit(repositoryRoot),
    platform: process.platform,
    architecture: os.arch(),
    ...input,
  });
  fs.mkdirSync(path.dirname(safePath), { recursive: true });
  fs.writeFileSync(safePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
