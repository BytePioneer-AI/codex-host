import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GATE_C_SCHEMA_VERSION, gateReportSchema } from "./contracts.mjs";
import { assertLocalEvidencePath } from "./workspace.mjs";

export function overallStatus(scenarios) {
  const required = scenarios.filter(({ required }) => required);
  if (required.some(({ status }) => status === "FAIL")) return "FAIL";
  if (required.some(({ status }) => status === "BLOCKED")) return "BLOCKED";
  return "PASS";
}

export function writeGateReport(repositoryRoot, outputPath, input) {
  const safePath = assertLocalEvidencePath(repositoryRoot, outputPath);
  const status = overallStatus(input.scenarios);
  const report = gateReportSchema.parse({
    schemaVersion: GATE_C_SCHEMA_VERSION,
    gate: "pi-rpc-capabilities",
    status,
    recordedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: os.arch(),
    ...input,
  });
  fs.mkdirSync(path.dirname(safePath), { recursive: true });
  fs.writeFileSync(safePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
