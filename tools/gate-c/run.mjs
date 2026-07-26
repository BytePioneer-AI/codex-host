import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { deriveCapabilities } from "./capabilities.mjs";
import { rawCaptureSchema } from "./contracts.mjs";
import { runExtensionProfile } from "./extension-scenarios.mjs";
import { runIsolatedProfile } from "./isolated-scenarios.mjs";
import { writeGateReport } from "./report.mjs";
import { writeSyntheticFixture } from "./synthetic-fixture.mjs";
import { createGateWorkspace, removeNonEvidenceWorkspace } from "./workspace.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const syntheticFixturePath = path.join(
  repositoryRoot,
  "tests",
  "fixtures",
  "gate-c",
  "hermetic.fixture.json",
);

function printResult(results) {
  console.log(
    JSON.stringify(
      results.map(({ result, outputPath }) => ({
        ...result,
        localEvidence: path.relative(repositoryRoot, outputPath),
      })),
      null,
      2,
    ),
  );
}

function hermetic() {
  const vitest = path.join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
  const result = spawnSync(process.execPath, [vitest, "run", "tools/gate-c"], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

async function isolated() {
  const workspace = createGateWorkspace(repositoryRoot, "isolated");
  try {
    const results = await runIsolatedProfile({ repositoryRoot, workspace });
    printResult(results);
    if (results.some(({ result }) => result.status !== "PASS")) process.exitCode = 2;
    return { results, workspace };
  } finally {
    removeNonEvidenceWorkspace(workspace);
  }
}

async function extension() {
  const workspace = createGateWorkspace(repositoryRoot, "extension");
  try {
    const results = await runExtensionProfile({ repositoryRoot, workspace });
    printResult(results);
    if (results.some(({ result }) => result.status !== "PASS")) process.exitCode = 2;
    return { results, workspace };
  } finally {
    removeNonEvidenceWorkspace(workspace);
  }
}

async function nativeLive() {
  const module = await import("./native-live-scenarios.mjs");
  const workspace = createGateWorkspace(repositoryRoot, "native-live");
  console.error(
    "[gate:c] Native Live uses the current Pi Provider/authentication and may access models or the network.",
  );
  console.error(`[gate:c] All file operations are restricted to ${workspace.cwd}`);
  try {
    const results = await module.runNativeLiveProfile({ repositoryRoot, workspace });
    printResult(results);
    if (results.some(({ result }) => result.required && result.status !== "PASS")) {
      process.exitCode = 2;
    }
    return { results, workspace };
  } finally {
    removeNonEvidenceWorkspace(workspace);
  }
}

function latestProfileRoot(profile) {
  const platformRoot = path.join(
    repositoryRoot,
    ".codexhost",
    "gate-c",
    `${process.platform}-${process.arch}`,
    profile,
  );
  const runs = fs
    .readdirSync(platformRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort()
    .reverse();
  if (runs.length === 0) throw new Error(`no local Gate C ${profile} run exists`);
  return path.join(platformRoot, runs[0]);
}

function resultsFromProfile(profile) {
  const root = latestProfileRoot(profile);
  const raw = path.join(root, "raw");
  const results = fs
    .readdirSync(raw)
    .filter((name) => name.endsWith(".capture.json"))
    .sort()
    .map((name) => {
      const outputPath = path.join(raw, name);
      const capture = rawCaptureSchema.parse(JSON.parse(fs.readFileSync(outputPath, "utf8")));
      return { result: capture.result, outputPath, commandSource: capture.commandSource };
    });
  return { root, results };
}

function finalize() {
  const profiles = ["isolated", "extension", "native-live"].map(resultsFromProfile);
  const all = profiles.flatMap(({ results }) => results);
  const scenarios = all.map(({ result }) => result);
  const platformRoot = path.dirname(path.dirname(profiles[0].root));
  const reportPath = path.join(platformRoot, "reports", "gate-c-report.local.json");
  const report = writeGateReport(repositoryRoot, reportPath, {
    commandSource: all[0]?.commandSource ?? "path",
    evidenceRoot: path.relative(repositoryRoot, platformRoot),
    scenarios,
    capabilities: deriveCapabilities(scenarios),
    impact:
      "Gate Extension evidence proves the RPC Question channel only; production Extension installation remains a separate product decision.",
    nextDecision:
      "Use PASS evidence for a separate Shared Contracts/PiAdapter change; stop and revise architecture on FAIL or BLOCKED required capabilities.",
  });
  console.log(JSON.stringify(report, null, 2));
  console.error(`[gate:c] local report: ${reportPath}`);
  process.exitCode = report.status === "PASS" ? 0 : report.status === "FAIL" ? 1 : 2;
  return report;
}

async function gate() {
  const isolatedRun = await isolated();
  const extensionRun = await extension();
  const liveRun = await nativeLive();
  const all = [...isolatedRun.results, ...extensionRun.results, ...liveRun.results];
  const scenarios = all.map(({ result }) => result);
  const reportPath = path.join(liveRun.workspace.reports, "gate-c-report.local.json");
  const report = writeGateReport(repositoryRoot, reportPath, {
    commandSource: all[0]?.commandSource ?? "path",
    evidenceRoot: path.relative(repositoryRoot, liveRun.workspace.root),
    scenarios,
    capabilities: deriveCapabilities(scenarios),
    impact:
      "Gate Extension evidence proves the RPC Question channel only; production Extension installation remains a separate product decision.",
    nextDecision:
      "Use PASS evidence for a separate Shared Contracts/PiAdapter change; stop and revise architecture on FAIL or BLOCKED required capabilities.",
  });
  console.log(JSON.stringify(report, null, 2));
  console.error(`[gate:c] local report: ${reportPath}`);
  process.exitCode = report.status === "PASS" ? 0 : report.status === "FAIL" ? 1 : 2;
}

const [command = "hermetic", argument] = process.argv.slice(2);
switch (command) {
  case "hermetic":
    hermetic();
    break;
  case "generate-fixture":
    await writeSyntheticFixture(path.resolve(argument ?? syntheticFixturePath));
    break;
  case "isolated":
    await isolated();
    break;
  case "extension":
    await extension();
    break;
  case "live":
    await nativeLive();
    break;
  case "gate":
    await gate();
    break;
  case "finalize":
    finalize();
    break;
  default:
    throw new Error(`unknown Gate C command '${command}'`);
}
