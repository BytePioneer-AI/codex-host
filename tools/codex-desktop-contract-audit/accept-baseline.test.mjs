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

function writeInterruptedTransaction(fixture_, report = validateAuditReport(auditReport())) {
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
        entry: { ...identity, baseline: relativeBaseline },
        report,
      },
      null,
      2,
    )}\n`,
  );
  return { baselinePath, journalPath };
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
      baseline: "baselines/macos-26.825.41651-7345.json",
    });
    expect(path.basename(result.baselinePath)).toBe("macos-26.825.41651-7345.json");
    expect(JSON.parse(fs.readFileSync(result.baselinePath, "utf8"))).toEqual(
      validateAuditReport(auditReport()),
    );
  });

  it("resumes an interrupted new-identity transaction after the baseline rename", () => {
    const oldIdentity = { ...identity, version: "26.824.1", build: "7000" };
    const fixture_ = fixture({ manifestIdentity: oldIdentity, baseline: "baselines/old.json" });
    const baselinePath = path.join(
      fixture_.auditDirectory,
      "baselines/macos-26.825.41651-7345.json",
    );
    const journalPath = path.join(fixture_.auditDirectory, ".accept-baseline-transaction.json");
    const resolvedBaselinePath = path.join(
      fs.realpathSync(fixture_.auditDirectory),
      "baselines/macos-26.825.41651-7345.json",
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

    const result = acceptReviewedBaseline({
      root: fixture_.root,
      manifestPath: fixture_.manifestPath,
      reportPath: fixture_.reportPath,
    });

    const manifest = JSON.parse(fs.readFileSync(fixture_.manifestPath, "utf8"));
    expect(manifest.desktops[1]).toEqual({
      ...identity,
      baseline: "baselines/macos-26.825.41651-7345.json",
    });
    expect(result).toMatchObject({ baselinePath: fs.realpathSync(baselinePath), appended: true });
    expect(fs.existsSync(journalPath)).toBe(false);
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
});
