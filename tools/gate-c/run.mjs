import { spawnSync } from "node:child_process";
import path from "node:path";

import { deriveCapabilities } from "./capabilities.mjs";
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
  console.error("[gate:c] Mutable Pi settings use a temporary config copy removed after the run.");
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

async function gate() {
  const isolatedRun = await isolated();
  const extensionRun = await extension();
  const liveRun = await nativeLive();
  const all = [...isolatedRun.results, ...extensionRun.results, ...liveRun.results];
  const scenarios = all.map(({ result }) => result);
  const platformRoot = path.dirname(path.dirname(liveRun.workspace.root));
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
    throw new Error(
      "gate:c:finalize no longer combines independent profile runs; run 'npm run gate:c' to produce an authoritative report",
    );
  default:
    throw new Error(`unknown Gate C command '${command}'`);
}
