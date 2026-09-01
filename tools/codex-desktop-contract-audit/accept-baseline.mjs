import fs from "node:fs";
import path from "node:path";

import { validateAuditReport } from "./report.mjs";
import { parseReviewedDesktopManifest } from "./reviewed-desktops.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const defaultManifestPath = path.join(import.meta.dirname, "reviewed-desktops.json");
const transactionFilename = ".accept-baseline-transaction.json";
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

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function transactionTemporaryPath(target) {
  return path.join(path.dirname(target), `.${path.basename(target)}.accept.tmp`);
}

function writeTransactionFile(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(transactionTemporaryPath(target), `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function journalFor(entry, report) {
  return { schemaVersion: 1, entry, report };
}

function parseJournal(value, manifestDirectory, report) {
  if (
    !exactKeys(value, ["schemaVersion", "entry", "report"]) ||
    value.schemaVersion !== 1 ||
    !exactKeys(value.entry, ["platform", "version", "build", "asarIntegrity", "baseline"])
  ) {
    throw new Error("pending baseline transaction journal is invalid");
  }
  const pendingReport = validateAuditReport(value.report);
  if (JSON.stringify(pendingReport) !== JSON.stringify(report)) {
    throw new Error("pending baseline transaction belongs to a different report");
  }
  const entry = parseReviewedDesktopManifest(
    { schemaVersion: 1, desktops: [value.entry] },
    manifestDirectory,
  ).desktops[0];
  if (!sameIdentity(entry, pendingReport.desktop)) {
    throw new Error("pending baseline transaction identity does not match its report");
  }
  return { entry, rawEntry: value.entry, report: pendingReport };
}

function reportsMatch(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resumePendingTransaction({
  journalPath,
  manifestDirectory,
  manifestPath,
  rawManifest,
  manifest,
  report,
}) {
  if (!pathEntryExists(journalPath)) return null;
  const confinedJournal = confinedExistingFile(
    manifestDirectory,
    journalPath,
    "pending transaction journal",
  );
  const pending = parseJournal(
    JSON.parse(fs.readFileSync(confinedJournal, "utf8")),
    manifestDirectory,
    report,
  );
  const baselinePath = pending.entry.baseline;
  assertConfinedDestination(manifestDirectory, baselinePath);
  if (!pathEntryExists(baselinePath)) {
    fs.rmSync(transactionTemporaryPath(baselinePath), { force: true });
    fs.rmSync(transactionTemporaryPath(manifestPath), { force: true });
    fs.rmSync(journalPath);
    return null;
  }

  let baselineReport;
  try {
    const confined = confinedExistingFile(
      manifestDirectory,
      baselinePath,
      "pending transaction baseline",
    );
    baselineReport = validateAuditReport(JSON.parse(fs.readFileSync(confined, "utf8")));
  } catch {
    throw new Error("pending transaction baseline does not match reviewed report");
  }
  if (!reportsMatch(baselineReport, pending.report)) {
    throw new Error("pending transaction baseline does not match reviewed report");
  }

  const existing = manifest.desktops.find((entry) => sameIdentity(entry, pending.entry));
  if (existing && existing.baseline !== baselinePath) {
    throw new Error("pending baseline transaction conflicts with the manifest");
  }
  if (!existing) {
    if (manifest.desktops.some((entry) => entry.baseline === baselinePath)) {
      throw new Error("pending baseline transaction conflicts with the manifest");
    }
    const nextManifest = {
      schemaVersion: 1,
      desktops: [...rawManifest.desktops, pending.rawEntry],
    };
    parseReviewedDesktopManifest(nextManifest, manifestDirectory);
    fs.rmSync(transactionTemporaryPath(manifestPath), { force: true });
    writeTransactionFile(manifestPath, nextManifest);
    fs.renameSync(transactionTemporaryPath(manifestPath), manifestPath);
  }
  fs.rmSync(journalPath);
  return { baselinePath, manifestPath, appended: true };
}

function commitNewIdentity({ journalPath, baselinePath, manifestPath, report, nextManifest }) {
  const entry = nextManifest.desktops.at(-1);
  const journalTemporary = writeTemporaryJson(journalPath, journalFor(entry, report));
  try {
    fs.renameSync(journalTemporary, journalPath);
  } finally {
    fs.rmSync(journalTemporary, { force: true });
  }

  writeTransactionFile(baselinePath, report);
  fs.renameSync(transactionTemporaryPath(baselinePath), baselinePath);
  writeTransactionFile(manifestPath, nextManifest);
  fs.renameSync(transactionTemporaryPath(manifestPath), manifestPath);
  fs.rmSync(journalPath);
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
  const journalPath = path.join(manifestDirectory, transactionFilename);
  const resumed = resumePendingTransaction({
    journalPath,
    manifestDirectory,
    manifestPath,
    rawManifest,
    manifest,
    report,
  });
  if (resumed) return resumed;
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

  if (nextManifest) {
    commitNewIdentity({ journalPath, baselinePath, manifestPath, report, nextManifest });
    return { baselinePath, manifestPath, appended: true };
  }

  const baselineTemporary = writeTemporaryJson(baselinePath, report);
  try {
    fs.renameSync(baselineTemporary, baselinePath);
  } finally {
    fs.rmSync(baselineTemporary, { force: true });
  }
  return { baselinePath, manifestPath, appended: false };
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
