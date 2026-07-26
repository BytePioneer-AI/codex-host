import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  desktopInteractiveEvidenceSchema,
  differentialResultSchema,
  gateReportSchema,
  macosDifferentialSummarySchema,
  macosLifecycleSummarySchema,
  probeInvocationSchema,
} from "./contracts.mjs";
import { runDifferential } from "../../tests/differential/codex-transparent-proxy.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const gatePlatform = process.platform === "win32" ? "windows" : process.platform;
if (!["windows", "darwin"].includes(gatePlatform)) {
  throw new Error("Gate A currently supports Windows and macOS only");
}
const platformName = gatePlatform === "darwin" ? "macos" : "windows";
const launcherPath = path.join(repositoryRoot, "target", "debug", `codexhost${executableSuffix}`);
const shimPath = path.join(repositoryRoot, "target", "debug", `codexhost-shim${executableSuffix}`);
const probePath = path.join(
  repositoryRoot,
  "target",
  "debug",
  `codexhost-probe${executableSuffix}`,
);
const probeShimPath = path.join(
  repositoryRoot,
  "target",
  "debug",
  `codexhost-shim-probe${executableSuffix}`,
);
const localOutput = path.join(repositoryRoot, ".codexhost", "gate-a", platformName);
const interactiveEvidencePath = path.join(
  repositoryRoot,
  "tests",
  "fixtures",
  "gate-a",
  platformName,
  "desktop-interactive.fixture.json",
);

let cachedLauncherEnvironment;

function run(executable, commandArguments, options = {}) {
  const result = spawnSync(executable, commandArguments, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function launcherEnvironment() {
  if (cachedLauncherEnvironment) return cachedLauncherEnvironment;
  if (process.platform !== "win32") {
    cachedLauncherEnvironment = { ...process.env };
    return cachedLauncherEnvironment;
  }
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$package = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1
if ($null -eq $package) { throw 'OpenAI.Codex AppX package is not installed' }
$package.Name
$package.PackageFamilyName
$package.Version.ToString()
$package.InstallLocation
`;
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (result.status !== 0) throw new Error(`AppX discovery failed: ${result.stderr.trim()}`);
  const values = result.stdout.replaceAll("\r", "").trim().split("\n");
  if (values.length !== 4 || values.some((value) => value.length === 0)) {
    throw new Error("AppX discovery returned an unexpected result");
  }
  cachedLauncherEnvironment = {
    ...process.env,
    CODEXHOST_PROBE_PACKAGE_NAME: values[0],
    CODEXHOST_PROBE_PACKAGE_FAMILY: values[1],
    CODEXHOST_PROBE_DESKTOP_VERSION: values[2],
    CODEXHOST_PROBE_INSTALL_ROOT: values[3],
  };
  return cachedLauncherEnvironment;
}

function requireProductBinaries() {
  const missing = [launcherPath, shimPath].filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(
      `Product binaries are missing: ${missing.join(", ")}. Run npm run build with the pinned toolchain first.`,
    );
  }
}

function requireProbeBinaries() {
  const result = run("cargo", [
    "build",
    "--locked",
    "--package",
    "codexhost-gate-a-native",
    "--features",
    "gate-tools",
  ]);
  if (result.status !== 0) {
    throw new Error(`Gate A native tools failed to build: ${result.stderr.trim()}`);
  }
  const missing = [probePath, probeShimPath].filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(`Gate A native binaries are missing after build: ${missing.join(", ")}`);
  }
}

function parseInspection(stdout) {
  const inspection = Object.fromEntries(
    stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error(`invalid launcher inspection line: ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  for (const key of [
    "platform",
    "desktop_version",
    "install_root",
    "desktop_executable",
    "packaged_codex_cli",
    "executable_codex_cli",
    "desktop_process_ids",
  ]) {
    if (!(key in inspection)) {
      throw new Error(`launcher inspection is missing '${key}'; rebuild the Rust workspace`);
    }
  }
  return inspection;
}

function inspect() {
  requireProductBinaries();
  const result = run(launcherPath, ["inspect"], { env: launcherEnvironment() });
  if (result.status !== 0) {
    throw new Error(`launcher preflight failed: ${result.stderr.trim()}`);
  }
  return parseInspection(result.stdout);
}

function repositoryCommit() {
  const result = run("git", ["rev-parse", "HEAD"]);
  if (result.status !== 0) return "unknown";
  const status = run("git", ["status", "--porcelain", "--untracked-files=normal"]);
  const dirty = status.status === 0 && status.stdout.trim().length > 0;
  return `${result.stdout.trim()}${dirty ? "-dirty" : ""}`;
}

function codexVersion(executable) {
  const result = run(executable, ["--version"]);
  if (result.status !== 0) return `unavailable: ${result.stderr.trim()}`;
  return result.stdout.trim();
}

function writeGateReport({
  inspection,
  status,
  evidence,
  completedScenarios,
  blockedScenarios,
  impact,
  nextDecision,
}) {
  const platformFields =
    platformName === "windows"
      ? {
          platform: "windows",
          gate: "windows-codex-transparent-proxy",
          windowsVersion: `${os.type()} ${os.release()} ${os.arch()}`,
        }
      : {
          platform: "macos",
          gate: "macos-codex-transparent-proxy",
          macosVersion: `${os.type()} ${os.release()}`,
          architecture: os.arch(),
        };
  const report = gateReportSchema.parse({
    schemaVersion: 1,
    ...platformFields,
    status,
    recordedAt: new Date().toISOString(),
    repositoryCommit: repositoryCommit(),
    desktopVersion: inspection.desktop_version,
    codexCliVersion: codexVersion(inspection.executable_codex_cli),
    evidence,
    completedScenarios,
    blockedScenarios,
    impact,
    nextDecision,
  });
  fs.mkdirSync(localOutput, { recursive: true });
  const outputPath = path.join(localOutput, "gate-a-report.local.json");
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, outputPath };
}

function preflight() {
  const inspection = inspect();
  console.log(JSON.stringify(inspection, null, 2));
  if (inspection.desktop_process_ids) {
    console.error(
      `Codex Desktop is running (PIDs: ${inspection.desktop_process_ids}). Close it normally before the isolated probe.`,
    );
    process.exitCode = 2;
  }
  return inspection;
}

function probe(launchModeArgument) {
  const inspection = inspect();
  if (inspection.desktop_process_ids) {
    throw new Error(
      `Codex Desktop is running (PIDs: ${inspection.desktop_process_ids}); refusing to reuse or terminate it`,
    );
  }
  requireProbeBinaries();
  const captureDirectory = path.join(localOutput, "raw");
  fs.mkdirSync(captureDirectory, { recursive: true });
  console.error("[gate:a] launching isolated Codex Desktop probe");
  const launchArguments = ["--shim", probeShimPath];
  if (platformName === "macos") {
    const launchMode = launchModeArgument ?? process.env.CODEXHOST_GATE_A_LAUNCH_MODE;
    if (!["launch-services", "direct-executable"].includes(launchMode)) {
      throw new Error(
        "macOS probe requires CODEXHOST_GATE_A_LAUNCH_MODE=launch-services or direct-executable",
      );
    }
    launchArguments.push("--launch-mode", launchMode, "--exit-after-capture");
  }
  launchArguments.push("--output", captureDirectory, "--wait-seconds", "30");
  const result = run(probePath, launchArguments, {
    env: launcherEnvironment(),
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.status !== 0) throw new Error("Launch Probe failed");
  console.error("[gate:a] Shim invocation captured");
  return inspection;
}

async function differential(inspection = inspect(), { live = false } = {}) {
  fs.mkdirSync(localOutput, { recursive: true });
  const outputPath = path.join(localOutput, "differential.local.json");
  const result = await runDifferential({
    stockCodexPath: inspection.executable_codex_cli,
    shimPath,
    outputPath,
    live,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.byteLayerEqual || result.unknownDifferences.length > 0) process.exitCode = 1;
  return { result, outputPath };
}

function finalizeMacos(inspection) {
  const fixtureDirectory = path.join(repositoryRoot, "tests", "fixtures", "gate-a", "macos");
  const invocationPath = path.join(fixtureDirectory, "desktop-shim-invocation.fixture.json");
  const differentialPath = path.join(
    fixtureDirectory,
    "official-cli-differential-live.fixture.json",
  );
  const lifecyclePath = path.join(fixtureDirectory, "lifecycle-summary.fixture.json");
  const interactivePath = path.join(fixtureDirectory, "desktop-interactive.fixture.json");
  const invocation = probeInvocationSchema.parse(
    JSON.parse(fs.readFileSync(invocationPath, "utf8")),
  );
  const differentialSummary = macosDifferentialSummarySchema.parse(
    JSON.parse(fs.readFileSync(differentialPath, "utf8")),
  );
  const lifecycle = macosLifecycleSummarySchema.parse(
    JSON.parse(fs.readFileSync(lifecyclePath, "utf8")),
  );
  const interactive = desktopInteractiveEvidenceSchema.parse(
    JSON.parse(fs.readFileSync(interactivePath, "utf8")),
  );
  if (
    invocation.desktopVersion !== inspection.desktop_version ||
    differentialSummary.desktopVersion !== inspection.desktop_version ||
    lifecycle.desktopVersion !== inspection.desktop_version ||
    interactive.desktopVersion !== inspection.desktop_version
  ) {
    throw new Error("reviewed macOS evidence Desktop version does not match the installed version");
  }
  const installedCodexVersion = codexVersion(inspection.executable_codex_cli);
  const installedBareCodexVersion = installedCodexVersion.replace(/^codex-cli\s+/u, "");
  if (
    differentialSummary.directVersion !== installedCodexVersion ||
    differentialSummary.shimVersion !== installedCodexVersion ||
    lifecycle.codexCliVersion !== installedBareCodexVersion ||
    interactive.codexCliVersion !== installedBareCodexVersion
  ) {
    throw new Error(
      "reviewed macOS evidence Codex CLI version does not match the installed version",
    );
  }
  if (
    invocation.launchMode !== "launch-services" ||
    lifecycle.launchMode !== invocation.launchMode ||
    interactive.launchMode !== invocation.launchMode
  ) {
    throw new Error("reviewed macOS evidence does not consistently use LaunchServices");
  }
  if (
    !differentialSummary.byteLayerEqual ||
    differentialSummary.unknownDifferences.length > 0 ||
    differentialSummary.protocolScenarios.some((scenario) => !scenario.equal)
  ) {
    throw new Error("reviewed macOS official CLI differential evidence is incomplete or failing");
  }
  if (lifecycle.blockedScenarios.length > 0) {
    throw new Error("reviewed macOS lifecycle evidence still contains blocked scenarios");
  }
  const { report, outputPath } = writeGateReport({
    inspection,
    status: "PASS",
    evidence: [
      path.relative(repositoryRoot, invocationPath),
      path.relative(repositoryRoot, differentialPath),
      path.relative(repositoryRoot, lifecyclePath),
      path.relative(repositoryRoot, interactivePath),
    ],
    completedScenarios: [
      "LaunchServices process-scoped CODEX_CLI_PATH inheritance",
      ...differentialSummary.protocolScenarios.map(
        ({ name }) => `official CLI direct/Shim differential: ${name}`,
      ),
      ...Object.keys(lifecycle.scenarios).map((name) => `lifecycle: ${name}`),
      ...Object.keys(interactive.scenarios).map((name) => `Desktop UI: ${name}`),
    ],
    blockedScenarios: [],
    impact:
      "macOS Codex Desktop native launch, transparent official CLI proxy, direct/Shim differential, interactive Thread, tool, cancellation, signal, crash, and bounded cleanup invariants passed for the recorded versions.",
    nextDecision:
      "The macOS Gate A native boundary may be used as verified input to separately proposed Protocol Core and Pi integration changes; Windows runtime regression evidence remains platform-specific.",
  });
  console.log(JSON.stringify(report, null, 2));
  console.error(`macOS Gate A PASS report: ${outputPath}`);
}

function finalize() {
  const inspection = inspect();
  if (inspection.desktop_process_ids) {
    throw new Error(
      `Codex Desktop is running (PIDs: ${inspection.desktop_process_ids}); finalize only after lifecycle cleanup`,
    );
  }
  if (platformName === "macos") {
    finalizeMacos(inspection);
    return;
  }
  const interactive = desktopInteractiveEvidenceSchema.parse(
    JSON.parse(fs.readFileSync(interactiveEvidencePath, "utf8")),
  );
  const differentialPath = path.join(localOutput, "differential.local.json");
  const differentialResult = differentialResultSchema.parse(
    JSON.parse(fs.readFileSync(differentialPath, "utf8")),
  );
  const expectedScenarios = [
    "initialize",
    "modelList",
    "threadList",
    "threadStart",
    "threadRead",
    "threadResume",
    "unknownMethod",
    "liveStream",
    "liveToolContinuation",
    "liveCancel",
  ];
  const passingScenarios = new Set(
    differentialResult.protocolScenarios
      .filter((scenario) => scenario.equal)
      .map((scenario) => scenario.name),
  );
  if (
    !differentialResult.byteLayerEqual ||
    differentialResult.unknownDifferences.length > 0 ||
    !expectedScenarios.every((scenario) => passingScenarios.has(scenario))
  ) {
    throw new Error("reviewed official CLI differential evidence is incomplete or failing");
  }
  if (interactive.desktopVersion !== inspection.desktop_version) {
    throw new Error("interactive evidence Desktop version does not match the installed version");
  }
  const { report, outputPath } = writeGateReport({
    inspection,
    status: "PASS",
    evidence: [
      path.relative(repositoryRoot, interactiveEvidencePath),
      path.relative(repositoryRoot, differentialPath),
      "tests/fixtures/gate-a/windows/desktop-shim-invocation.fixture.json",
    ],
    completedScenarios: [
      ...Object.keys(interactive.scenarios),
      ...expectedScenarios.map((scenario) => `official CLI differential: ${scenario}`),
    ],
    blockedScenarios: [],
    impact:
      "Windows Codex Desktop transparent proxy launch, protocol forwarding, interaction, and lifecycle invariants passed for the recorded versions.",
    nextDecision:
      "Gate A may be used as the verified native boundary for a separately proposed Protocol Core change.",
  });
  console.log(JSON.stringify(report, null, 2));
  console.error(`Gate A PASS report: ${outputPath}`);
}

async function gate() {
  if (platformName === "macos") {
    finalize();
    return;
  }
  const inspection = inspect();
  if (inspection.desktop_process_ids) {
    const { report, outputPath } = writeGateReport({
      inspection,
      status: "BLOCKED",
      evidence: ["Launcher inspect detected existing Codex Desktop processes"],
      completedScenarios: [
        "AppX installation discovery",
        "Desktop-managed official CLI byte match",
      ],
      blockedScenarios: [
        "isolated CODEX_CLI_PATH launch",
        "Desktop create/continue/stream/tool/cancel",
      ],
      impact:
        "The existing single-instance Desktop cannot prove process-scoped environment inheritance.",
      nextDecision: "Close Codex Desktop normally, then rerun npm run gate:a.",
    });
    console.log(JSON.stringify(report, null, 2));
    console.error(`Gate A is BLOCKED; local report: ${outputPath}`);
    process.exitCode = 2;
    return;
  }

  probe();
  console.error("[gate:a] running official CLI direct/Shim differential");
  const { result, outputPath: differentialPath } = await differential(inspection);
  const differences = result.unknownDifferences;
  const status = differences.length === 0 && result.byteLayerEqual ? "BLOCKED" : "FAIL";
  const { report, outputPath } = writeGateReport({
    inspection,
    status,
    evidence: ["Launch Probe capture", differentialPath],
    completedScenarios: ["isolated launch", "Shim invocation capture", "official CLI differential"],
    blockedScenarios:
      status === "BLOCKED" ? ["manual Desktop create/continue/stream/tool/cancel validation"] : [],
    impact:
      status === "FAIL"
        ? `Unknown direct/Shim differences: ${differences.join(", ")}`
        : "Automated checks passed; interactive Desktop scenarios still require an observed test run.",
    nextDecision:
      status === "FAIL"
        ? "Do not proceed to Protocol Core; classify and resolve the recorded differences."
        : "Complete the versioned interactive Desktop checklist and update the reviewed Gate record.",
  });
  console.log(JSON.stringify(report, null, 2));
  console.error(`Gate A report: ${outputPath}`);
  if (status !== "PASS") process.exitCode = status === "FAIL" ? 1 : 2;
}

const [command = "preflight", commandArgument] = process.argv.slice(2);
switch (command) {
  case "preflight":
    preflight();
    break;
  case "probe":
    probe(commandArgument);
    break;
  case "differential":
    await differential();
    break;
  case "live-differential":
    await differential(undefined, { live: true });
    break;
  case "gate":
    await gate();
    break;
  case "finalize":
    finalize();
    break;
  default:
    throw new Error(`unknown Gate A command '${command}'`);
}
