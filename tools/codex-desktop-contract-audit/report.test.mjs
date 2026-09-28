import { describe, expect, it } from "vitest";

import { aggregateVerdict, buildSurfaceResults, validateAuditReport } from "./report.mjs";

const contracts = {
  composer: {
    composerCount: 1,
    visibleComposerCount: 1,
    activeComposerCount: 1,
    modelCandidateCount: 1,
    verifiedModelCandidateCount: 1,
    permissionCandidateCount: 0,
    verifiedPermissionCandidateCount: 0,
    contextUsageCandidateCount: 0,
    verifiedContextUsageCandidateCount: 0,
    sendButtonCount: 1,
    trailingActionOwnerCount: 1,
  },
  model: { draftCount: 1, conversationCount: 0, missingCount: 0, ambiguousCount: 0 },
  settings: { railCount: 1, visibleRailCount: 1, insertionPointCount: 1 },
  sidebar: { rowCount: 0, titleOwnerCount: 0, resolvedThreadCount: 0, ambiguousThreadCount: 0 },
  transcript: {
    turnCount: 0,
    itemNodeCount: 0,
    identifiedItemCount: 0,
    textBodyCount: 0,
    textBodyOwnerCount: 0,
  },
  codexUsageGate: { composerCount: 1, ownerCount: 1, reserveGateCount: 1, accountGateCount: 1 },
  fork: { annotatedResponseCount: 0, candidateButtonCount: 0, verifiedButtonCount: 0 },
  production: {
    bindingPresent: false,
    adapterState: "absent",
    adapterReason: "absent",
    titlePolicyState: "absent",
    draftPrewarmPolicyState: "absent",
  },
};

function reportFor(surfaces) {
  return {
    schemaVersion: 1,
    recordedAt: "2026-08-30T00:00:00.000Z",
    mode: "read-only",
    verdict: aggregateVerdict(surfaces),
    desktop: { version: "26.1", build: "100", asarIntegrity: `sha256:${"a".repeat(64)}` },
    browser: { browser: "Chrome/151", protocolVersion: "1.3" },
    checksRun: ["renderer-contracts-read-only"],
    baseline: { supplied: false, version: null, build: null },
    surfaces,
  };
}

describe("Codex Desktop contract audit report", () => {
  it("keeps state-conditional surfaces unverified instead of failed", () => {
    const surfaces = buildSurfaceResults(contracts);
    expect(surfaces.find(({ id }) => id === "permission")?.verdict).toBe("unverified");
    expect(surfaces.find(({ id }) => id === "fork")?.verdict).toBe("unverified");
    expect(surfaces.find(({ id }) => id === "composer")?.verdict).toBe("no-impact");
  });

  it("classifies the Codex usage gate from owner and gate cardinality", () => {
    const verdictFor = (gate) =>
      buildSurfaceResults({
        ...contracts,
        codexUsageGate: { ...contracts.codexUsageGate, ...gate },
      }).find(({ id }) => id === "codex-usage-gate");
    expect(verdictFor({})?.verdict).toBe("no-impact");
    expect(verdictFor({ reserveGateCount: 0 })).toMatchObject({
      verdict: "confirmed-impact",
      reason: "codex-usage-gate-cardinality",
    });
    expect(verdictFor({ ownerCount: 2 })?.verdict).toBe("confirmed-impact");
    // API-key sign-in: the Account gate returns before reading usage.
    expect(verdictFor({ accountGateCount: 0 })).toMatchObject({
      verdict: "unverified",
      reason: "codex-usage-account-gate-dormant",
    });
    expect(verdictFor({ composerCount: 0, ownerCount: 0, reserveGateCount: 0 })?.verdict).toBe(
      "unverified",
    );
  });

  it("accepts a reviewed baseline that predates a newer surface", () => {
    const older = buildSurfaceResults(contracts).filter(({ id }) => id !== "codex-usage-gate");
    expect(() => validateAuditReport(reportFor(older))).toThrow("incomplete");
    const baseline = validateAuditReport(reportFor(older), { baseline: true });
    const gate = buildSurfaceResults(contracts, baseline).find(
      ({ id }) => id === "codex-usage-gate",
    );
    expect(gate).toMatchObject({ verdict: "no-impact", baselineChanged: false });
    expect(gate?.evidence.static).toBe("not-run");
  });

  it("reports ambiguous active ownership as confirmed impact", () => {
    const surfaces = buildSurfaceResults({
      ...contracts,
      model: { draftCount: 0, conversationCount: 0, missingCount: 0, ambiguousCount: 1 },
    });
    expect(surfaces.find(({ id }) => id === "model")?.verdict).toBe("confirmed-impact");
    expect(aggregateVerdict(surfaces)).toBe("confirmed-impact");
  });

  it("separates controlled installation from unexercised behavior", () => {
    const surfaces = buildSurfaceResults(contracts, null, {
      adapterState: "ready",
      titlePolicyState: "ready",
      draftPrewarmPolicyState: "ready",
      titleBehavior: "not-run",
      settingsBehavior: "not-run",
      forkBehavior: "not-run",
    });
    const title = surfaces.find(({ id }) => id === "title");
    expect(title?.evidence.installation).toBe("pass");
    expect(title?.evidence.behavior).toBe("not-run");
  });

  it("treats a changed inactive baseline surface as possible impact", () => {
    const baselineSurfaces = buildSurfaceResults(contracts);
    const baseline = validateAuditReport(reportFor(baselineSurfaces));
    const surfaces = buildSurfaceResults(
      {
        ...contracts,
        fork: { annotatedResponseCount: 0, candidateButtonCount: 1, verifiedButtonCount: 0 },
      },
      baseline,
    );
    expect(surfaces.find(({ id }) => id === "fork")?.verdict).toBe("possible-impact");
  });

  it("reports an empty transcript as unverified rather than passing", () => {
    const surfaces = buildSurfaceResults(contracts);
    const transcript = surfaces.find(({ id }) => id === "transcript");
    expect(transcript?.verdict).toBe("unverified");
    expect(transcript?.evidence.liveStructure).toBe("inactive");
  });

  it("passes a transcript whose Items publish their Host Item ids", () => {
    const surfaces = buildSurfaceResults({
      ...contracts,
      transcript: {
        turnCount: 4,
        itemNodeCount: 5,
        identifiedItemCount: 9,
        textBodyCount: 2,
        textBodyOwnerCount: 2,
      },
    });
    expect(surfaces.find(({ id }) => id === "transcript")?.verdict).toBe("no-impact");
  });

  it("reports transcript Items that stopped publishing Host Item ids", () => {
    const surfaces = buildSurfaceResults({
      ...contracts,
      transcript: {
        turnCount: 4,
        itemNodeCount: 5,
        identifiedItemCount: 0,
        textBodyCount: 2,
        textBodyOwnerCount: 2,
      },
    });
    expect(surfaces.find(({ id }) => id === "transcript")?.verdict).toBe("confirmed-impact");
    expect(aggregateVerdict(surfaces)).toBe("confirmed-impact");
  });

  it("flags a transcript that lost its retained text lane against a baseline", () => {
    const active = {
      ...contracts,
      transcript: {
        turnCount: 4,
        itemNodeCount: 5,
        identifiedItemCount: 9,
        textBodyCount: 2,
        textBodyOwnerCount: 2,
      },
    };
    const baseline = validateAuditReport(reportFor(buildSurfaceResults(active)));
    const surfaces = buildSurfaceResults(
      {
        ...active,
        transcript: { ...active.transcript, textBodyCount: 0, textBodyOwnerCount: 0 },
      },
      baseline,
    );
    expect(surfaces.find(({ id }) => id === "transcript")?.verdict).toBe("possible-impact");
  });

  it("rejects unknown report fields instead of persisting them", () => {
    const surfaces = buildSurfaceResults(contracts);
    expect(() => validateAuditReport({ ...reportFor(surfaces), privatePrompt: "secret" })).toThrow(
      "unknown or missing fields",
    );
  });
});
