import fs from "node:fs";
import path from "node:path";

import { validateAuditReport } from "./report.mjs";
import { findReviewedDesktop, parseReviewedDesktopManifest } from "./reviewed-desktops.mjs";
import { parseAuditArguments, readDesktopIdentity, runCodexDesktopAudit } from "./run.mjs";

const manifestPath = path.join(import.meta.dirname, "reviewed-desktops.json");
const identityFields = ["platform", "version", "build", "asarIntegrity"];
const rejectedVerdicts = new Set(["possible-impact", "confirmed-impact"]);

function sameIdentity(left, right) {
  return identityFields.every((field) => left?.[field] === right?.[field]);
}

export async function runReviewedDesktopIntegration(input) {
  const reviewed = findReviewedDesktop(input.manifest, input.identity);
  if (!fs.existsSync(reviewed.baseline)) throw new Error("reviewed baseline is missing");
  const baseline = validateAuditReport(JSON.parse(fs.readFileSync(reviewed.baseline, "utf8")));
  if (!sameIdentity(baseline.desktop, input.identity)) {
    throw new Error("reviewed baseline Desktop identity does not match");
  }

  const auditResult = await input.runAudit({
    ...(input.auditOptions ?? {}),
    mode: "controlled",
    baselinePath: reviewed.baseline,
    desktopPlatform: input.identity.platform,
    desktopVersion: input.identity.version,
    desktopBuild: input.identity.build,
    asarIntegrity: input.identity.asarIntegrity,
  });
  const report = auditResult.report ?? auditResult;
  if (!new Set(["no-impact", "unverified", ...rejectedVerdicts]).has(report.verdict)) {
    throw new Error(`invalid integration verdict: ${String(report.verdict)}`);
  }
  if (rejectedVerdicts.has(report.verdict)) {
    throw new Error(`controlled audit reported ${report.verdict}`);
  }
  const unverifiedSurfaces = (report.surfaces ?? [])
    .filter((surface) => surface.verdict === "unverified")
    .map((surface) => surface.id);
  return { ...report, unverifiedSurfaces };
}

async function main() {
  const auditOptions = parseAuditArguments(process.argv.slice(2));
  const identity = readDesktopIdentity(auditOptions);
  const manifest = parseReviewedDesktopManifest(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")),
    import.meta.dirname,
  );
  const result = await runReviewedDesktopIntegration({
    identity,
    manifest,
    auditOptions,
    runAudit: async (options) => runCodexDesktopAudit(options),
  });
  if (result.unverifiedSurfaces.length > 0) {
    console.error(`warning: unverified surfaces: ${result.unverifiedSurfaces.join(", ")}`);
  }
  console.log(
    JSON.stringify({
      type: "codex-desktop-reviewed-integration",
      verdict: result.verdict,
      unverifiedSurfaces: result.unverifiedSurfaces,
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
