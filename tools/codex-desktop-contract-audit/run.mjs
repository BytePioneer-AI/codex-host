import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  aggregateVerdict,
  auditReportMarkdown,
  buildSurfaceResults,
  validateAuditReport,
} from "./report.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const defaultOutputRoot = path.join(repositoryRoot, ".codexhost", "update-impact");
const defaultEndpoint = "http://127.0.0.1:9222";
const defaultInspectorEndpoint = "http://127.0.0.1:9223";
const productionRendererAgents = Object.freeze([
  "codex",
  "pi",
  "claude-code",
  "deepseek-harness",
  "grok",
  "omp",
  "qwen-code",
]);

function usage() {
  console.error(`usage:
  npm run audit:codex-desktop -- [--mode read-only|controlled]
    [--endpoint <loopback-url>] [--inspector-endpoint <loopback-url>]
    [--baseline <audit-report.json>] [--output <directory>]
    [--desktop-version <version>] [--desktop-build <build>]
    [--asar-integrity <sha256:value>] [--launcher <absolute-codexhost-file>]

Read-only mode is the default. Controlled mode installs the existing production Renderer policies
and binding in the selected Desktop; it still does not submit, create a Thread, open Settings, fork,
or exercise title creation.`);
}

function boundedText(value, option, maximum = 128) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new Error(`${option} must be bounded single-line text`);
  }
  return value;
}

export function parseAuditArguments(arguments_) {
  const options = {
    mode: "read-only",
    endpoint: defaultEndpoint,
    inspectorEndpoint: defaultInspectorEndpoint,
    baselinePath: null,
    outputRoot: defaultOutputRoot,
    desktopVersion: null,
    desktopBuild: null,
    asarIntegrity: null,
    launcher: null,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = () => {
      index += 1;
      if (index >= arguments_.length) throw new Error(`${argument} requires a value`);
      return arguments_[index];
    };
    switch (argument) {
      case "--mode":
        options.mode = value();
        if (!["read-only", "controlled"].includes(options.mode)) {
          throw new Error("--mode must be read-only or controlled");
        }
        break;
      case "--endpoint":
        options.endpoint = value();
        break;
      case "--inspector-endpoint":
        options.inspectorEndpoint = value();
        break;
      case "--baseline":
        options.baselinePath = path.resolve(value());
        break;
      case "--output":
        options.outputRoot = path.resolve(value());
        break;
      case "--desktop-version":
        options.desktopVersion = boundedText(value(), argument, 64);
        break;
      case "--desktop-build":
        options.desktopBuild = boundedText(value(), argument, 64);
        break;
      case "--asar-integrity":
        options.asarIntegrity = boundedText(value(), argument, 80);
        break;
      case "--launcher":
        options.launcher = path.resolve(value());
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option: ${argument}`);
    }
  }
  validateLoopbackEndpoint(options.endpoint, "--endpoint");
  validateLoopbackEndpoint(options.inspectorEndpoint, "--inspector-endpoint");
  return options;
}

export function validateLoopbackEndpoint(value, option) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`${option} must be a loopback HTTP URL`);
  }
  const port = url.port === "" ? 80 : Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${option} must contain a valid port`);
  }
}

function parseInspectOutput(output) {
  const values = {};
  for (const line of output.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return {
    version: values.desktop_version ?? "unknown",
    build: values.desktop_build ?? values.desktop_version ?? "unknown",
    asarIntegrity: values.desktop_asar_integrity ?? "unknown",
  };
}

function readDesktopIdentity(options) {
  if (options.desktopVersion && options.desktopBuild && options.asarIntegrity) {
    return {
      version: options.desktopVersion,
      build: options.desktopBuild,
      asarIntegrity: options.asarIntegrity,
    };
  }
  const launcher = options.launcher ?? path.join(repositoryRoot, "target", "debug", "codexhost");
  if (!path.isAbsolute(launcher) || !fs.existsSync(launcher)) {
    throw new Error(
      "Desktop identity requires --desktop-version, --desktop-build, and --asar-integrity, or a built --launcher",
    );
  }
  const inspected = parseInspectOutput(
    execFileSync(launcher, ["inspect"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  );
  return {
    version: options.desktopVersion ?? inspected.version,
    build: options.desktopBuild ?? inspected.build,
    asarIntegrity: options.asarIntegrity ?? inspected.asarIntegrity,
  };
}

function loadBaseline(pathname) {
  if (pathname === null) return null;
  return validateAuditReport(JSON.parse(fs.readFileSync(pathname, "utf8")));
}

function safeDirectorySegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, "-").slice(0, 96) || "unknown";
}

function controlledEvidence(snapshot) {
  return {
    adapterState: snapshot.binding.adapter.state,
    titlePolicyState: snapshot.titlePolicyReadiness.state,
    draftPrewarmPolicyState: snapshot.draftPrewarmPolicy.state,
    titleBehavior: "not-run",
    settingsBehavior: "not-run",
    forkBehavior: "not-run",
  };
}

async function runControlled(options, rendererSource, installRendererControlSession) {
  const session = await installRendererControlSession({
    inspectorEndpoint: options.inspectorEndpoint,
    rendererSource,
    enabledAgents: productionRendererAgents,
    timeoutMs: 60_000,
  });
  try {
    return controlledEvidence(session.snapshot);
  } finally {
    session.close();
  }
}

async function main() {
  const options = parseAuditArguments(process.argv.slice(2));
  const auditBundlePath = path.join(
    repositoryRoot,
    "packages",
    "renderer-extension",
    "dist",
    "contract-audit.js",
  );
  const productionBundlePath = path.join(
    repositoryRoot,
    "packages",
    "renderer-extension",
    "dist",
    "production.js",
  );
  if (!fs.existsSync(auditBundlePath))
    throw new Error("Renderer audit bundle is missing; run npm run build:renderer");
  if (options.mode === "controlled" && !fs.existsSync(productionBundlePath)) {
    throw new Error("Production Renderer bundle is missing; run npm run build:renderer");
  }
  const identity = readDesktopIdentity(options);
  const baseline = loadBaseline(options.baselinePath);
  const rendererAuditSource = fs.readFileSync(auditBundlePath, "utf8");
  const { inspectDesktopContracts, installRendererControlSession } =
    await import("../../packages/desktop-control/dist/index.js");
  const observation = await inspectDesktopContracts({
    endpoint: options.endpoint,
    inspectorEndpoint: options.inspectorEndpoint,
    rendererAuditSource,
  });
  const controlled =
    options.mode === "controlled"
      ? await runControlled(
          options,
          fs.readFileSync(productionBundlePath, "utf8"),
          installRendererControlSession,
        )
      : null;
  const finalObservation = controlled
    ? await inspectDesktopContracts({
        endpoint: options.endpoint,
        inspectorEndpoint: options.inspectorEndpoint,
        rendererAuditSource,
      })
    : observation;
  const surfaces = buildSurfaceResults(finalObservation.contracts, baseline, controlled);
  const report = validateAuditReport({
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    mode: options.mode,
    verdict: aggregateVerdict(surfaces),
    desktop: identity,
    browser: observation.browser,
    checksRun: [
      "desktop-identity",
      "browser-identity",
      "renderer-contracts-read-only",
      ...(baseline ? ["reviewed-baseline-comparison"] : []),
      ...(controlled ? ["controlled-production-installation"] : []),
    ],
    baseline: {
      supplied: baseline !== null,
      version: baseline?.desktop.version ?? null,
      build: baseline?.desktop.build ?? null,
    },
    surfaces,
  });
  const outputDirectory = path.join(options.outputRoot, safeDirectorySegment(identity.version));
  fs.mkdirSync(outputDirectory, { recursive: true });
  const jsonPath = path.join(outputDirectory, "audit-report.json");
  const markdownPath = path.join(outputDirectory, "audit-report.md");
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, auditReportMarkdown(report), "utf8");
  console.log(
    JSON.stringify({
      type: "codex-desktop-contract-audit",
      verdict: report.verdict,
      jsonPath,
      markdownPath,
    }),
  );
  if (report.verdict === "confirmed-impact") process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
