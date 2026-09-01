import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { acceptReviewedBaseline } from "./accept-baseline.mjs";
import { AUDIT_SURFACE_IDS, validateAuditReport } from "./report.mjs";

const identity = {
  platform: "macos",
  version: "26.825.41651",
  build: "7345",
  asarIntegrity: "sha256:c089b63abb7ca4a751072c0da434248db13c32bed9c363e1b7e5428584b0576d",
};

const temporaryDirectories = [];
const transactionId = "11111111-1111-4111-8111-111111111111";
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function surface(id, verdict = "no-impact") {
  return {
    id,
    verdict,
    reason: "reviewed-contract",
    evidence: {
      static: "pass",
      liveStructure: "pass",
      installation: "pass",
      behavior: "not-run",
    },
    observed: {},
    baselineChanged: false,
  };
}

function auditReport(desktop = identity, verdict = "no-impact") {
  const surfaces = AUDIT_SURFACE_IDS.map((id, index) =>
    surface(id, index === 0 ? verdict : "no-impact"),
  );
  return {
    schemaVersion: 1,
    recordedAt: "2026-09-01T00:00:00.000Z",
    mode: "controlled",
    verdict,
    desktop,
    browser: { browser: "Chrome/151", protocolVersion: "1.3" },
    checksRun: ["controlled-production-installation"],
    baseline: { supplied: false, version: null, build: null },
    surfaces,
  };
}

function fixture({ manifestIdentity = identity, baseline = "baselines/reviewed.json" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-accept-"));
  temporaryDirectories.push(root);
  const auditDirectory = path.join(root, "tools", "codex-desktop-contract-audit");
  fs.mkdirSync(auditDirectory, { recursive: true });
  const manifestPath = path.join(auditDirectory, "reviewed-desktops.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ schemaVersion: 1, desktops: [{ ...manifestIdentity, baseline }] }, null, 2)}\n`,
  );
  const reportPath = path.join(root, "candidate.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(auditReport(), null, 2)}\n`);
  return { root, auditDirectory, manifestPath, reportPath };
}

function baselineFiles(auditDirectory) {
  const directory = path.join(auditDirectory, "baselines");
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}

function writeReport(fixture_, report, filename) {
  const reportPath = path.join(fixture_.root, filename);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

async function settle(promise) {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

async function runConcurrentAcceptance(fixture_, firstReportPath, secondReportPath) {
  let entered = false;
  let enteredResolve;
  let releaseResolve;
  const enteredPromise = new Promise((resolve) => {
    enteredResolve = resolve;
  });
  const releasePromise = new Promise((resolve) => {
    releaseResolve = resolve;
  });
  const first = acceptReviewedBaseline({
    root: fixture_.root,
    manifestPath: fixture_.manifestPath,
    reportPath: firstReportPath,
    __testBarrier: async (lock) => {
      entered = true;
      enteredResolve(lock);
      await releasePromise;
    },
  });
  expect(entered).toBe(true);
  const heldLock = await enteredPromise;
  const heldStat = fs.lstatSync(heldLock.lockPath);
  const second = Promise.resolve().then(() =>
    acceptReviewedBaseline({
      root: fixture_.root,
      manifestPath: fixture_.manifestPath,
      reportPath: secondReportPath,
    }),
  );
  let secondOutcome;
  try {
    secondOutcome = await settle(second);
    const currentStat = fs.lstatSync(heldLock.lockPath);
    const currentLock = JSON.parse(fs.readFileSync(heldLock.lockPath, "utf8"));
    expect({ dev: currentStat.dev, ino: currentStat.ino }).toEqual({
      dev: heldStat.dev,
      ino: heldStat.ino,
    });
    expect(currentLock).toEqual({ schemaVersion: 1, transactionId: heldLock.transactionId });
  } finally {
    releaseResolve();
  }
  return Promise.all([settle(Promise.resolve(first)), Promise.resolve(secondOutcome)]);
}

function expectOneLocked(outcomes) {
  expect(outcomes[0].status).toBe("fulfilled");
  expect(outcomes[1].status).toBe("rejected");
  expect(outcomes[1].reason).toMatchObject({ message: expect.stringMatching(/locked/i) });
}

function writeInterruptedTransaction(
  fixture_,
  report = validateAuditReport(auditReport()),
  pendingTransactionId = transactionId,
) {
  const relativeBaseline = "baselines/macos-26.825.41651-7345.json";
  const baselinePath = path.join(fixture_.auditDirectory, relativeBaseline);
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
  const journalPath = path.join(fixture_.auditDirectory, ".accept-baseline-transaction.json");
  fs.writeFileSync(
    journalPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        transactionId: pendingTransactionId,
        entry: { ...identity, baseline: relativeBaseline },
        report,
      },
      null,
      2,
    )}\n`,
  );
  return { baselinePath, journalPath, transactionId: pendingTransactionId };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("reviewed baseline acceptance", () => {
  it("populates a predeclared missing baseline without changing the manifest", () => {
    const fixture_ = fixture();
    const before = fs.readFileSync(fixture_.manifestPath, "utf8");

    const result = acceptReviewedBaseline({
      root: fixture_.root,
      manifestPath: fixture_.manifestPath,
      reportPath: fixture_.reportPath,
    });

    expect(fs.readFileSync(fixture_.manifestPath, "utf8")).toBe(before);
    expect(JSON.parse(fs.readFileSync(result.baselinePath, "utf8"))).toEqual(
      validateAuditReport(auditReport()),
    );
  });

  it("appends a new identity and writes a sanitized baseline", () => {
    const oldIdentity = { ...identity, version: "26.824.1", build: "7000" };
    const fixture_ = fixture({ manifestIdentity: oldIdentity, baseline: "baselines/old.json" });

    const result = acceptReviewedBaseline({
      root: fixture_.root,
      manifestPath: fixture_.manifestPath,
      reportPath: fixture_.reportPath,
    });

    const manifest = JSON.parse(fs.readFileSync(fixture_.manifestPath, "utf8"));
    expect(manifest.desktops).toHaveLength(2);
    expect(manifest.desktops[1]).toEqual({
      ...identity,
      baseline:
        "baselines/macos-26.825.41651-7345-c089b63abb7ca4a751072c0da434248db13c32bed9c363e1b7e5428584b0576d.json",
    });
    expect(path.basename(result.baselinePath)).toBe(
      "macos-26.825.41651-7345-c089b63abb7ca4a751072c0da434248db13c32bed9c363e1b7e5428584b0576d.json",
    );
    expect(JSON.parse(fs.readFileSync(result.baselinePath, "utf8"))).toEqual(
      validateAuditReport(auditReport()),
    );
  });

  it("uses the complete ASAR digest to distinguish identities with a shared prefix", () => {
    const oldIdentity = { ...identity, version: "26.824.1", build: "7000" };
    const fixture_ = fixture({ manifestIdentity: oldIdentity, baseline: "baselines/old.json" });
    const secondIdentity = {
      ...identity,
      asarIntegrity: "sha256:c089b63abb7ca4a7bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
    const secondReportPath = writeReport(fixture_, auditReport(secondIdentity), "candidate-2.json");

    const first = acceptReviewedBaseline({
      root: fixture_.root,
      manifestPath: fixture_.manifestPath,
      reportPath: fixture_.reportPath,
    });
    const second = acceptReviewedBaseline({
      root: fixture_.root,
      manifestPath: fixture_.manifestPath,
      reportPath: secondReportPath,
    });

    const manifest = JSON.parse(fs.readFileSync(fixture_.manifestPath, "utf8"));
    expect(path.basename(first.baselinePath)).toBe(
      "macos-26.825.41651-7345-c089b63abb7ca4a751072c0da434248db13c32bed9c363e1b7e5428584b0576d.json",
    );
    expect(path.basename(second.baselinePath)).toBe(
      "macos-26.825.41651-7345-c089b63abb7ca4a7bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json",
    );
    expect(manifest.desktops.slice(1)).toEqual([
      {
        ...identity,
        baseline:
          "baselines/macos-26.825.41651-7345-c089b63abb7ca4a751072c0da434248db13c32bed9c363e1b7e5428584b0576d.json",
      },
      {
        ...secondIdentity,
        baseline:
          "baselines/macos-26.825.41651-7345-c089b63abb7ca4a7bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json",
      },
    ]);
    expect(JSON.parse(fs.readFileSync(first.baselinePath, "utf8")).desktop).toEqual(identity);
    expect(JSON.parse(fs.readFileSync(second.baselinePath, "utf8")).desktop).toEqual(
      secondIdentity,
    );
  });

  it("resumes an interrupted new-identity transaction after the baseline rename", () => {
    const oldIdentity = { ...identity, version: "26.824.1", build: "7000" };
    const fixture_ = fixture({ manifestIdentity: oldIdentity, baseline: "baselines/old.json" });
    const baselinePath = path.join(
      fixture_.auditDirectory,
      "baselines/macos-26.825.41651-7345-c089b63abb7ca4a751072c0da434248db13c32bed9c363e1b7e5428584b0576d.json",
    );
    const journalPath = path.join(
      path.dirname(fs.realpathSync(fixture_.manifestPath)),
      ".accept-baseline-transaction.json",
    );
    const resolvedBaselinePath = path.join(
      fs.realpathSync(fixture_.auditDirectory),
      "baselines/macos-26.825.41651-7345-c089b63abb7ca4a751072c0da434248db13c32bed9c363e1b7e5428584b0576d.json",
    );
    const renameSync = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      renameSync(from, to);
      if (to === resolvedBaselinePath) {
        throw new Error("simulated interruption after baseline rename");
      }
    });

    expect(() =>
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: fixture_.reportPath,
      }),
    ).toThrow("simulated interruption");
    rename.mockRestore();
    expect(fs.existsSync(journalPath)).toBe(true);
    expect(fs.existsSync(baselinePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(fixture_.manifestPath, "utf8")).desktops).toHaveLength(1);
    const pendingTransactionId = JSON.parse(fs.readFileSync(journalPath, "utf8")).transactionId;
    expect(pendingTransactionId).toMatch(uuidV4);
    const foreignTemporary = path.join(
      path.dirname(fixture_.manifestPath),
      `.${path.basename(fixture_.manifestPath)}.accept.tmp`,
    );
    fs.writeFileSync(foreignTemporary, "foreign\n");

    const result = acceptReviewedBaseline({
      root: fixture_.root,
      manifestPath: fixture_.manifestPath,
      reportPath: fixture_.reportPath,
    });

    const manifest = JSON.parse(fs.readFileSync(fixture_.manifestPath, "utf8"));
    expect(manifest.desktops[1]).toEqual({
      ...identity,
      baseline:
        "baselines/macos-26.825.41651-7345-c089b63abb7ca4a751072c0da434248db13c32bed9c363e1b7e5428584b0576d.json",
    });
    expect(result).toMatchObject({ baselinePath: fs.realpathSync(baselinePath), appended: true });
    expect(fs.existsSync(journalPath)).toBe(false);
    expect(fs.readFileSync(foreignTemporary, "utf8")).toBe("foreign\n");
  });

  it("leaves an unrelated baseline untouched when interrupted recovery conflicts", () => {
    const oldIdentity = { ...identity, version: "26.824.1", build: "7000" };
    const fixture_ = fixture({ manifestIdentity: oldIdentity, baseline: "baselines/old.json" });
    const { baselinePath, journalPath } = writeInterruptedTransaction(fixture_);
    fs.writeFileSync(baselinePath, "unrelated\n");
    const manifestBefore = fs.readFileSync(fixture_.manifestPath, "utf8");

    expect(() =>
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: fixture_.reportPath,
      }),
    ).toThrow(/pending.*baseline.*match|transaction.*conflict/i);
    expect(fs.readFileSync(baselinePath, "utf8")).toBe("unrelated\n");
    expect(fs.readFileSync(fixture_.manifestPath, "utf8")).toBe(manifestBefore);
    expect(fs.existsSync(journalPath)).toBe(true);
  });

  it("rejects unknown pending journal entry fields without changing outputs", () => {
    const oldIdentity = { ...identity, version: "26.824.1", build: "7000" };
    const fixture_ = fixture({ manifestIdentity: oldIdentity, baseline: "baselines/old.json" });
    const { baselinePath, journalPath } = writeInterruptedTransaction(fixture_);
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    journal.entry.privatePath = "/secret";
    fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    const manifestBefore = fs.readFileSync(fixture_.manifestPath, "utf8");
    const baselineBefore = fs.readFileSync(baselinePath, "utf8");

    expect(() =>
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: fixture_.reportPath,
      }),
    ).toThrow(/journal.*invalid|unknown.*field/i);
    expect(fs.readFileSync(fixture_.manifestPath, "utf8")).toBe(manifestBefore);
    expect(fs.readFileSync(baselinePath, "utf8")).toBe(baselineBefore);
    expect(fs.existsSync(journalPath)).toBe(true);
  });

  it("rejects a pending journal with a non-UUID transaction id", () => {
    const oldIdentity = { ...identity, version: "26.824.1", build: "7000" };
    const fixture_ = fixture({ manifestIdentity: oldIdentity, baseline: "baselines/old.json" });
    const { baselinePath, journalPath } = writeInterruptedTransaction(
      fixture_,
      validateAuditReport(auditReport()),
      "not-a-uuid",
    );
    const manifestBefore = fs.readFileSync(fixture_.manifestPath, "utf8");
    const baselineBefore = fs.readFileSync(baselinePath, "utf8");

    expect(() =>
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: fixture_.reportPath,
      }),
    ).toThrow(/journal.*invalid|transaction.*id/i);
    expect(fs.readFileSync(fixture_.manifestPath, "utf8")).toBe(manifestBefore);
    expect(fs.readFileSync(baselinePath, "utf8")).toBe(baselineBefore);
    expect(fs.existsSync(journalPath)).toBe(true);
  });

  it("retains a missing-baseline journal when the manifest identity has another baseline", () => {
    const fixture_ = fixture({ manifestIdentity: identity, baseline: "baselines/conflict.json" });
    const { baselinePath, journalPath } = writeInterruptedTransaction(fixture_);
    fs.rmSync(baselinePath);
    const manifestBefore = fs.readFileSync(fixture_.manifestPath, "utf8");
    const journalBefore = fs.readFileSync(journalPath, "utf8");

    expect(() =>
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: fixture_.reportPath,
      }),
    ).toThrow(/pending.*transaction.*conflict/i);
    expect(fs.readFileSync(fixture_.manifestPath, "utf8")).toBe(manifestBefore);
    expect(fs.readFileSync(journalPath, "utf8")).toBe(journalBefore);
    expect(fs.existsSync(baselinePath)).toBe(false);
    expect(fs.existsSync(path.join(fixture_.auditDirectory, "baselines/conflict.json"))).toBe(
      false,
    );
  });

  it("retains a missing-baseline journal when another identity owns its baseline path", () => {
    const oldIdentity = { ...identity, version: "26.824.1", build: "7000" };
    const relativeBaseline = "baselines/macos-26.825.41651-7345.json";
    const fixture_ = fixture({ manifestIdentity: oldIdentity, baseline: relativeBaseline });
    const { baselinePath, journalPath } = writeInterruptedTransaction(fixture_);
    fs.rmSync(baselinePath);
    const manifestBefore = fs.readFileSync(fixture_.manifestPath, "utf8");
    const journalBefore = fs.readFileSync(journalPath, "utf8");

    expect(() =>
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: fixture_.reportPath,
      }),
    ).toThrow(/pending.*transaction.*conflict/i);
    expect(fs.readFileSync(fixture_.manifestPath, "utf8")).toBe(manifestBefore);
    expect(fs.readFileSync(journalPath, "utf8")).toBe(journalBefore);
    expect(fs.existsSync(baselinePath)).toBe(false);
  });

  it("preserves a same-transaction temp whose content is not owned by the journal", () => {
    const oldIdentity = { ...identity, version: "26.824.1", build: "7000" };
    const fixture_ = fixture({ manifestIdentity: oldIdentity, baseline: "baselines/old.json" });
    const pending = writeInterruptedTransaction(fixture_);
    fs.rmSync(pending.baselinePath);
    const foreignTemporary = path.join(
      fixture_.auditDirectory,
      `.${path.basename(fixture_.manifestPath)}.accept-${pending.transactionId}.tmp`,
    );
    fs.writeFileSync(foreignTemporary, "foreign\n");
    const manifestBefore = fs.readFileSync(fixture_.manifestPath, "utf8");
    const journalBefore = fs.readFileSync(pending.journalPath, "utf8");

    expect(() =>
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: fixture_.reportPath,
      }),
    ).toThrow(/temporary.*conflict|transaction.*temp/i);
    expect(fs.readFileSync(foreignTemporary, "utf8")).toBe("foreign\n");
    expect(fs.readFileSync(fixture_.manifestPath, "utf8")).toBe(manifestBefore);
    expect(fs.readFileSync(pending.journalPath, "utf8")).toBe(journalBefore);
  });

  it.each(["possible-impact", "confirmed-impact"])(
    "rejects %s without changing outputs",
    (verdict) => {
      const fixture_ = fixture();
      fs.writeFileSync(fixture_.reportPath, `${JSON.stringify(auditReport(identity, verdict))}\n`);
      const before = fs.readFileSync(fixture_.manifestPath, "utf8");

      expect(() =>
        acceptReviewedBaseline({
          root: fixture_.root,
          manifestPath: fixture_.manifestPath,
          reportPath: fixture_.reportPath,
        }),
      ).toThrow(verdict);
      expect(fs.readFileSync(fixture_.manifestPath, "utf8")).toBe(before);
      expect(baselineFiles(fixture_.auditDirectory)).toEqual([]);
    },
  );

  it("rejects an existing baseline without changing either output", () => {
    const fixture_ = fixture();
    const baselinePath = path.join(fixture_.auditDirectory, "baselines", "reviewed.json");
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, "existing\n");
    const before = fs.readFileSync(fixture_.manifestPath, "utf8");

    expect(() =>
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: fixture_.reportPath,
      }),
    ).toThrow(/baseline.*exists/i);
    expect(fs.readFileSync(fixture_.manifestPath, "utf8")).toBe(before);
    expect(fs.readFileSync(baselinePath, "utf8")).toBe("existing\n");
  });

  it("rejects duplicate manifest identities without changing outputs", () => {
    const fixture_ = fixture();
    const manifest = JSON.parse(fs.readFileSync(fixture_.manifestPath, "utf8"));
    manifest.desktops.push({ ...manifest.desktops[0], baseline: "baselines/duplicate.json" });
    fs.writeFileSync(fixture_.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const before = fs.readFileSync(fixture_.manifestPath, "utf8");

    expect(() =>
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: fixture_.reportPath,
      }),
    ).toThrow(/duplicate/i);
    expect(fs.readFileSync(fixture_.manifestPath, "utf8")).toBe(before);
    expect(baselineFiles(fixture_.auditDirectory)).toEqual([]);
  });

  it("rejects the wrong report schema without changing outputs", () => {
    const fixture_ = fixture();
    fs.writeFileSync(fixture_.reportPath, '{"schemaVersion":2}\n');
    const before = fs.readFileSync(fixture_.manifestPath, "utf8");

    expect(() =>
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: fixture_.reportPath,
      }),
    ).toThrow(/audit report/i);
    expect(fs.readFileSync(fixture_.manifestPath, "utf8")).toBe(before);
    expect(baselineFiles(fixture_.auditDirectory)).toEqual([]);
  });

  it("rejects a report path outside the supplied root without changing outputs", () => {
    const fixture_ = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-outside-"));
    temporaryDirectories.push(outside);
    const outsideReport = path.join(outside, "candidate.json");
    fs.writeFileSync(outsideReport, `${JSON.stringify(auditReport())}\n`);
    const before = fs.readFileSync(fixture_.manifestPath, "utf8");

    expect(() =>
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: outsideReport,
      }),
    ).toThrow(/report.*root|confined/i);
    expect(fs.readFileSync(fixture_.manifestPath, "utf8")).toBe(before);
    expect(baselineFiles(fixture_.auditDirectory)).toEqual([]);
  });

  it("rejects a baseline directory symlink that escapes the manifest directory", () => {
    const fixture_ = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codexhost-baseline-outside-"));
    temporaryDirectories.push(outside);
    fs.symlinkSync(outside, path.join(fixture_.auditDirectory, "baselines"));
    const before = fs.readFileSync(fixture_.manifestPath, "utf8");

    expect(() =>
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: fixture_.reportPath,
      }),
    ).toThrow(/baseline.*confined|symlink/i);
    expect(fs.readFileSync(fixture_.manifestPath, "utf8")).toBe(before);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("preserves an existing acceptance lock and fails closed with manual recovery guidance", () => {
    const fixture_ = fixture();
    const lockPath = path.join(fixture_.auditDirectory, ".accept-baseline.lock");
    const lock = `${JSON.stringify({ schemaVersion: 1, transactionId }, null, 2)}\n`;
    fs.writeFileSync(lockPath, lock);
    const manifestBefore = fs.readFileSync(fixture_.manifestPath, "utf8");

    expect(() =>
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: fixture_.reportPath,
      }),
    ).toThrow(/locked.*manual|locked.*exact.*file/i);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(lock);
    expect(fs.readFileSync(fixture_.manifestPath, "utf8")).toBe(manifestBefore);
    expect(baselineFiles(fixture_.auditDirectory)).toEqual([]);
  });

  it("never replaces a journal that appears before journal installation", () => {
    const oldIdentity = { ...identity, version: "26.824.1", build: "7000" };
    const fixture_ = fixture({ manifestIdentity: oldIdentity, baseline: "baselines/old.json" });
    const journalPath = path.join(
      path.dirname(fs.realpathSync(fixture_.manifestPath)),
      ".accept-baseline-transaction.json",
    );
    const foreign = "foreign journal\n";
    const manifestBefore = fs.readFileSync(fixture_.manifestPath, "utf8");
    const linkSync = fs.linkSync.bind(fs);
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      if (destination === journalPath) fs.writeFileSync(journalPath, foreign, { flag: "wx" });
      return linkSync(source, destination);
    });

    expect(() =>
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: fixture_.reportPath,
      }),
    ).toThrow(/exist|journal/i);
    expect(fs.readFileSync(journalPath, "utf8")).toBe(foreign);
    expect(fs.readFileSync(fixture_.manifestPath, "utf8")).toBe(manifestBefore);
    expect(baselineFiles(fixture_.auditDirectory)).toEqual([]);
    expect(fs.existsSync(path.join(fixture_.auditDirectory, ".accept-baseline.lock"))).toBe(false);
  });

  it("serializes concurrent predeclared acceptance of the same report", async () => {
    const fixture_ = fixture();

    const outcomes = await runConcurrentAcceptance(
      fixture_,
      fixture_.reportPath,
      fixture_.reportPath,
    );

    expectOneLocked(outcomes);
    expect(JSON.parse(fs.readFileSync(outcomes[0].value.baselinePath, "utf8"))).toEqual(
      validateAuditReport(auditReport()),
    );
    expect(fs.existsSync(path.join(fixture_.auditDirectory, ".accept-baseline.lock"))).toBe(false);
    expect(
      fs.existsSync(path.join(fixture_.auditDirectory, ".accept-baseline-transaction.json")),
    ).toBe(false);
    expect(() =>
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: fixture_.reportPath,
      }),
    ).toThrow(/baseline.*exists/i);
  });

  it("does not overwrite a predeclared baseline during concurrent different-report acceptance", async () => {
    const fixture_ = fixture();
    const secondReport = {
      ...auditReport(),
      recordedAt: "2026-09-01T00:00:01.000Z",
    };
    const secondReportPath = writeReport(fixture_, secondReport, "candidate-2.json");

    const outcomes = await runConcurrentAcceptance(fixture_, fixture_.reportPath, secondReportPath);

    expectOneLocked(outcomes);
    const baselineBefore = fs.readFileSync(outcomes[0].value.baselinePath, "utf8");
    expect(JSON.parse(baselineBefore)).toEqual(validateAuditReport(auditReport()));
    expect(() =>
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: secondReportPath,
      }),
    ).toThrow(/baseline.*exists/i);
    expect(fs.readFileSync(outcomes[0].value.baselinePath, "utf8")).toBe(baselineBefore);
  });

  it("serializes concurrent append acceptance of the same identity and report", async () => {
    const oldIdentity = { ...identity, version: "26.824.1", build: "7000" };
    const fixture_ = fixture({ manifestIdentity: oldIdentity, baseline: "baselines/old.json" });

    const outcomes = await runConcurrentAcceptance(
      fixture_,
      fixture_.reportPath,
      fixture_.reportPath,
    );

    expectOneLocked(outcomes);
    const manifest = JSON.parse(fs.readFileSync(fixture_.manifestPath, "utf8"));
    expect(manifest.desktops).toHaveLength(2);
    expect(manifest.desktops[1]).toMatchObject(identity);
    expect(fs.existsSync(outcomes[0].value.baselinePath)).toBe(true);
    expect(
      fs.existsSync(path.join(fixture_.auditDirectory, ".accept-baseline-transaction.json")),
    ).toBe(false);
    expect(() =>
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: fixture_.reportPath,
      }),
    ).toThrow(/baseline.*exists/i);
  });

  it("retries a locked different append without losing the first manifest update", async () => {
    const oldIdentity = { ...identity, version: "26.824.1", build: "7000" };
    const fixture_ = fixture({ manifestIdentity: oldIdentity, baseline: "baselines/old.json" });
    const secondIdentity = {
      ...identity,
      version: "26.825.41652",
      build: "7346",
      asarIntegrity: `sha256:${"b".repeat(64)}`,
    };
    const secondReportPath = writeReport(fixture_, auditReport(secondIdentity), "candidate-2.json");

    const outcomes = await runConcurrentAcceptance(fixture_, fixture_.reportPath, secondReportPath);
    expectOneLocked(outcomes);

    const retry = acceptReviewedBaseline({
      root: fixture_.root,
      manifestPath: fixture_.manifestPath,
      reportPath: secondReportPath,
    });
    const manifest = JSON.parse(fs.readFileSync(fixture_.manifestPath, "utf8"));
    expect(retry.appended).toBe(true);
    expect(manifest.desktops).toHaveLength(3);
    expect(manifest.desktops.slice(1).map(({ version }) => version)).toEqual([
      identity.version,
      secondIdentity.version,
    ]);
    expect(new Set(manifest.desktops.slice(1).map(({ baseline }) => baseline)).size).toBe(2);
    expect(fs.existsSync(outcomes[0].value.baselinePath)).toBe(true);
    expect(fs.existsSync(retry.baselinePath)).toBe(true);
  });

  it("releases its own lock when the private barrier throws synchronously", () => {
    const fixture_ = fixture();
    const lockPath = path.join(fixture_.auditDirectory, ".accept-baseline.lock");

    expect(() =>
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: fixture_.reportPath,
        __testBarrier: () => {
          throw new Error("synchronous barrier failure");
        },
      }),
    ).toThrow("synchronous barrier failure");
    expect(fs.existsSync(lockPath)).toBe(false);

    const retry = acceptReviewedBaseline({
      root: fixture_.root,
      manifestPath: fixture_.manifestPath,
      reportPath: fixture_.reportPath,
    });
    expect(fs.existsSync(retry.baselinePath)).toBe(true);
  });

  it("releases its own lock when the private barrier rejects asynchronously", async () => {
    const fixture_ = fixture();
    const lockPath = path.join(fixture_.auditDirectory, ".accept-baseline.lock");

    await expect(
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: fixture_.reportPath,
        __testBarrier: async () => {
          throw new Error("asynchronous barrier failure");
        },
      }),
    ).rejects.toThrow("asynchronous barrier failure");
    expect(fs.existsSync(lockPath)).toBe(false);

    const retry = acceptReviewedBaseline({
      root: fixture_.root,
      manifestPath: fixture_.manifestPath,
      reportPath: fixture_.reportPath,
    });
    expect(fs.existsSync(retry.baselinePath)).toBe(true);
  });

  it("preserves a replacement lock when release ownership no longer matches", async () => {
    const fixture_ = fixture();
    const foreign = `${JSON.stringify(
      { schemaVersion: 1, transactionId: "22222222-2222-4222-8222-222222222222" },
      null,
      2,
    )}\n`;
    let replacementPath;

    await expect(
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: fixture_.reportPath,
        __testBarrier: async ({ lockPath }) => {
          replacementPath = lockPath;
          fs.rmSync(lockPath);
          fs.writeFileSync(lockPath, foreign);
        },
      }),
    ).rejects.toThrow(/lock ownership changed|foreign lock preserved/i);
    expect(fs.readFileSync(replacementPath, "utf8")).toBe(foreign);
  });

  it("preserves a tampered lock that is no longer valid ownership metadata", async () => {
    const fixture_ = fixture();
    const tampered = "not-json\n";
    let lockPath;

    await expect(
      acceptReviewedBaseline({
        root: fixture_.root,
        manifestPath: fixture_.manifestPath,
        reportPath: fixture_.reportPath,
        __testBarrier: async (lock) => {
          lockPath = lock.lockPath;
          fs.writeFileSync(lockPath, tampered);
        },
      }),
    ).rejects.toThrow(/lock ownership changed|foreign lock preserved/i);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(tampered);
  });
});
