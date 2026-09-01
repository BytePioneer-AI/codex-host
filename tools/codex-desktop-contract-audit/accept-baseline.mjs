import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateAuditReport } from "./report.mjs";
import { parseReviewedDesktopManifest } from "./reviewed-desktops.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const defaultManifestPath = path.join(import.meta.dirname, "reviewed-desktops.json");
const transactionFilename = ".accept-baseline-transaction.json";
const lockFilename = ".accept-baseline.lock";
const identityFields = ["platform", "version", "build", "asarIntegrity"];
const rejectedVerdicts = new Set(["possible-impact", "confirmed-impact"]);
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

function parseLock(value) {
  if (
    !exactKeys(value, ["schemaVersion", "transactionId"]) ||
    value.schemaVersion !== 1 ||
    typeof value.transactionId !== "string" ||
    !uuidV4.test(value.transactionId)
  ) {
    throw new Error("baseline acceptance lock ownership is invalid; foreign lock preserved");
  }
  return value;
}

function acquireAcceptanceLock(manifestDirectory) {
  const lockPath = path.join(manifestDirectory, lockFilename);
  const transactionId = randomUUID();
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(
        "baseline acceptance is locked; fail closed. After verifying no acceptance process is running, manually inspect and remove the exact .accept-baseline.lock file, then retry",
        { cause: error },
      );
    }
    throw error;
  }
  const stat = fs.fstatSync(descriptor);
  const content = `${JSON.stringify({ schemaVersion: 1, transactionId }, null, 2)}\n`;
  try {
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    return { lockPath, transactionId, descriptor, stat, content };
  } catch (error) {
    fs.closeSync(descriptor);
    const current = fs.lstatSync(lockPath);
    if (current.dev === stat.dev && current.ino === stat.ino) fs.rmSync(lockPath);
    throw error;
  }
}

function releaseAcceptanceLock(lock) {
  try {
    const currentStat = fs.lstatSync(lock.lockPath);
    const currentContent = fs.readFileSync(lock.lockPath, "utf8");
    let current;
    try {
      current = parseLock(JSON.parse(currentContent));
    } catch {
      throw new Error("baseline acceptance lock ownership changed; foreign lock preserved");
    }
    const finalStat = fs.lstatSync(lock.lockPath);
    if (
      currentStat.dev !== lock.stat.dev ||
      currentStat.ino !== lock.stat.ino ||
      finalStat.dev !== lock.stat.dev ||
      finalStat.ino !== lock.stat.ino ||
      current.transactionId !== lock.transactionId ||
      currentContent !== lock.content
    ) {
      throw new Error("baseline acceptance lock ownership changed; foreign lock preserved");
    }
    fs.rmSync(lock.lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("baseline acceptance lock ownership changed; foreign lock preserved", {
        cause: error,
      });
    }
    throw error;
  } finally {
    fs.closeSync(lock.descriptor);
  }
}

function transactionTemporaryPath(target, transactionId) {
  return path.join(path.dirname(target), `.${path.basename(target)}.accept-${transactionId}.tmp`);
}

function writeTransactionFile(target, value, transactionId) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    transactionTemporaryPath(target, transactionId),
    `${JSON.stringify(value, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    },
  );
}

function journalFor(transactionId, entry, report) {
  return { schemaVersion: 1, transactionId, entry, report };
}

function readJournalSnapshot(journalPath) {
  const firstStat = fs.lstatSync(journalPath);
  const content = fs.readFileSync(journalPath, "utf8");
  const secondStat = fs.lstatSync(journalPath);
  if (firstStat.dev !== secondStat.dev || firstStat.ino !== secondStat.ino) {
    throw new Error("pending transaction journal ownership changed; foreign journal preserved");
  }
  return { journalPath, stat: secondStat, content };
}

function removeOwnedJournal(snapshot) {
  try {
    const firstStat = fs.lstatSync(snapshot.journalPath);
    const content = fs.readFileSync(snapshot.journalPath, "utf8");
    const secondStat = fs.lstatSync(snapshot.journalPath);
    if (
      firstStat.dev !== snapshot.stat.dev ||
      firstStat.ino !== snapshot.stat.ino ||
      secondStat.dev !== snapshot.stat.dev ||
      secondStat.ino !== snapshot.stat.ino ||
      content !== snapshot.content
    ) {
      throw new Error("pending transaction journal ownership changed; foreign journal preserved");
    }
    fs.rmSync(snapshot.journalPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("pending transaction journal ownership changed; foreign journal preserved", {
        cause: error,
      });
    }
    throw error;
  }
}

function parseJournal(value, manifestDirectory, report) {
  if (
    !exactKeys(value, ["schemaVersion", "transactionId", "entry", "report"]) ||
    value.schemaVersion !== 1 ||
    typeof value.transactionId !== "string" ||
    !uuidV4.test(value.transactionId) ||
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
  return {
    transactionId: value.transactionId,
    entry,
    rawEntry: value.entry,
    report: pendingReport,
  };
}

function reportsMatch(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function removeOwnedTransactionFile(pathname, expected) {
  if (!pathEntryExists(pathname)) return;
  let actual;
  try {
    actual = JSON.parse(fs.readFileSync(pathname, "utf8"));
  } catch {
    throw new Error("pending transaction temporary file conflicts with its journal");
  }
  if (!reportsMatch(actual, expected)) {
    throw new Error("pending transaction temporary file conflicts with its journal");
  }
  fs.rmSync(pathname);
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
  confinedExistingFile(manifestDirectory, journalPath, "pending transaction journal");
  const journalSnapshot = readJournalSnapshot(journalPath);
  const pending = parseJournal(JSON.parse(journalSnapshot.content), manifestDirectory, report);
  const baselinePath = pending.entry.baseline;
  assertConfinedDestination(manifestDirectory, baselinePath);
  const existing = manifest.desktops.find((entry) => sameIdentity(entry, pending.entry));
  if (
    (existing && existing.baseline !== baselinePath) ||
    manifest.desktops.some(
      (entry) => entry.baseline === baselinePath && !sameIdentity(entry, pending.entry),
    )
  ) {
    throw new Error("pending baseline transaction conflicts with the manifest");
  }
  if (!pathEntryExists(baselinePath)) {
    const pendingManifest = existing
      ? rawManifest
      : { schemaVersion: 1, desktops: [...rawManifest.desktops, pending.rawEntry] };
    removeOwnedTransactionFile(
      transactionTemporaryPath(baselinePath, pending.transactionId),
      pending.report,
    );
    removeOwnedTransactionFile(
      transactionTemporaryPath(manifestPath, pending.transactionId),
      pendingManifest,
    );
    removeOwnedJournal(journalSnapshot);
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

  if (!existing) {
    const nextManifest = {
      schemaVersion: 1,
      desktops: [...rawManifest.desktops, pending.rawEntry],
    };
    parseReviewedDesktopManifest(nextManifest, manifestDirectory);
    removeOwnedTransactionFile(
      transactionTemporaryPath(manifestPath, pending.transactionId),
      nextManifest,
    );
    writeTransactionFile(manifestPath, nextManifest, pending.transactionId);
    fs.renameSync(transactionTemporaryPath(manifestPath, pending.transactionId), manifestPath);
  } else {
    removeOwnedTransactionFile(
      transactionTemporaryPath(manifestPath, pending.transactionId),
      rawManifest,
    );
  }
  removeOwnedJournal(journalSnapshot);
  return { baselinePath, manifestPath, appended: true };
}

function commitNewIdentity({ journalPath, baselinePath, manifestPath, report, nextManifest }) {
  const entry = nextManifest.desktops.at(-1);
  const transactionId = randomUUID();
  const journalTemporary = transactionTemporaryPath(journalPath, transactionId);
  writeTransactionFile(journalPath, journalFor(transactionId, entry, report), transactionId);
  let journalSnapshot;
  try {
    fs.linkSync(journalTemporary, journalPath);
    journalSnapshot = readJournalSnapshot(journalPath);
  } finally {
    fs.rmSync(journalTemporary, { force: true });
  }

  writeTransactionFile(baselinePath, report, transactionId);
  fs.renameSync(transactionTemporaryPath(baselinePath, transactionId), baselinePath);
  writeTransactionFile(manifestPath, nextManifest, transactionId);
  fs.renameSync(transactionTemporaryPath(manifestPath, transactionId), manifestPath);
  removeOwnedJournal(journalSnapshot);
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
  const manifestDirectory = path.dirname(manifestPath);
  const acceptWhileLocked = () => {
    const report = validateAuditReport(JSON.parse(fs.readFileSync(reportPath, "utf8")));
    if (rejectedVerdicts.has(report.verdict)) {
      throw new Error(`cannot accept ${report.verdict} audit report`);
    }

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
      const digest = report.desktop.asarIntegrity.slice("sha256:".length);
      const filename = `${safeSegment(report.desktop.platform)}-${safeSegment(report.desktop.version)}-${safeSegment(report.desktop.build)}-${digest}.json`;
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
  };

  let releaseWithPromise = false;
  const lock = acquireAcceptanceLock(manifestDirectory);
  try {
    if (input.__testBarrier === undefined) return acceptWhileLocked();
    if (typeof input.__testBarrier !== "function") {
      throw new Error("acceptance test barrier must be a function");
    }
    const barrierResult = input.__testBarrier({
      lockPath: lock.lockPath,
      transactionId: lock.transactionId,
    });
    const acceptance = Promise.resolve(barrierResult)
      .then(acceptWhileLocked)
      .finally(() => releaseAcceptanceLock(lock));
    releaseWithPromise = true;
    return acceptance;
  } finally {
    if (!releaseWithPromise) releaseAcceptanceLock(lock);
  }
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
