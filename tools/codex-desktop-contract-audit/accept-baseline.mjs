import fs from "node:fs";
import path from "node:path";

import { validateAuditReport } from "./report.mjs";
import { parseReviewedDesktopManifest } from "./reviewed-desktops.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const defaultManifestPath = path.join(import.meta.dirname, "reviewed-desktops.json");
const identityFields = ["platform", "version", "build", "asarIntegrity"];
const rejectedVerdicts = new Set(["possible-impact", "confirmed-impact"]);

function isConfined(root, pathname) {
  const relative = path.relative(root, pathname);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function confinedExistingFile(root, pathname, label) {
  const resolvedRoot = fs.realpathSync(root);
  const resolved = fs.realpathSync(
    path.isAbsolute(pathname) ? pathname : path.resolve(root, pathname),
  );
  if (!isConfined(resolvedRoot, resolved)) throw new Error(`${label} must be confined to root`);
  if (!fs.statSync(resolved).isFile()) throw new Error(`${label} must be a file`);
  return resolved;
}

function pathEntryExists(pathname) {
  try {
    fs.lstatSync(pathname);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertConfinedDestination(root, pathname) {
  if (!isConfined(root, pathname)) throw new Error("baseline path must be confined");
  let ancestor = path.dirname(pathname);
  while (!pathEntryExists(ancestor)) ancestor = path.dirname(ancestor);
  const resolvedAncestor = fs.realpathSync(ancestor);
  if (resolvedAncestor !== root && !isConfined(root, resolvedAncestor)) {
    throw new Error("baseline path must be confined; symlink escapes manifest directory");
  }
}

function safeSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, "-").slice(0, 64) || "unknown";
}

function sameIdentity(left, right) {
  return identityFields.every((field) => left?.[field] === right?.[field]);
}

function temporaryPath(target) {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
}

function writeTemporaryJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = temporaryPath(target);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return temporary;
}

export function acceptReviewedBaseline(input) {
  if (!input?.reportPath) throw new Error("--report is required");
  const root = fs.realpathSync(input.root ?? repositoryRoot);
  const reportPath = confinedExistingFile(root, input.reportPath, "report path");
  const manifestPath = confinedExistingFile(
    root,
    input.manifestPath ?? defaultManifestPath,
    "manifest path",
  );
  const report = validateAuditReport(JSON.parse(fs.readFileSync(reportPath, "utf8")));
  if (rejectedVerdicts.has(report.verdict)) {
    throw new Error(`cannot accept ${report.verdict} audit report`);
  }

  const manifestDirectory = path.dirname(manifestPath);
  const rawManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const manifest = parseReviewedDesktopManifest(rawManifest, manifestDirectory);
  const existing = manifest.desktops.find((entry) => sameIdentity(entry, report.desktop));
  let baselinePath;
  let nextManifest = null;
  if (existing) {
    baselinePath = existing.baseline;
  } else {
    const filename = `${safeSegment(report.desktop.platform)}-${safeSegment(report.desktop.version)}-${safeSegment(report.desktop.build)}.json`;
    const relativeBaseline = path.join("baselines", filename);
    baselinePath = path.resolve(manifestDirectory, relativeBaseline);
    if (manifest.desktops.some((entry) => entry.baseline === baselinePath)) {
      throw new Error("baseline destination is already declared");
    }
    nextManifest = {
      schemaVersion: 1,
      desktops: [...rawManifest.desktops, { ...report.desktop, baseline: relativeBaseline }],
    };
    parseReviewedDesktopManifest(nextManifest, manifestDirectory);
  }
  assertConfinedDestination(manifestDirectory, baselinePath);
  if (pathEntryExists(baselinePath)) throw new Error("baseline already exists");

  const baselineTemporary = writeTemporaryJson(baselinePath, report);
  const manifestTemporary = nextManifest ? writeTemporaryJson(manifestPath, nextManifest) : null;
  try {
    fs.renameSync(baselineTemporary, baselinePath);
    if (manifestTemporary) {
      try {
        fs.renameSync(manifestTemporary, manifestPath);
      } catch (error) {
        fs.rmSync(baselinePath, { force: true });
        throw error;
      }
    }
  } finally {
    fs.rmSync(baselineTemporary, { force: true });
    if (manifestTemporary) fs.rmSync(manifestTemporary, { force: true });
  }
  return { baselinePath, manifestPath, appended: nextManifest !== null };
}

function parseArguments(arguments_) {
  let reportPath = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] !== "--report") throw new Error(`unknown option: ${arguments_[index]}`);
    index += 1;
    if (index >= arguments_.length) throw new Error("--report requires a value");
    if (reportPath !== null) throw new Error("--report must be supplied once");
    reportPath = arguments_[index];
  }
  if (reportPath === null) throw new Error("--report is required");
  return reportPath;
}

function main() {
  const result = acceptReviewedBaseline({ reportPath: parseArguments(process.argv.slice(2)) });
  console.log(
    JSON.stringify({
      type: "codex-desktop-baseline-accepted",
      baselinePath: result.baselinePath,
      manifestPath: result.manifestPath,
      appended: result.appended,
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
