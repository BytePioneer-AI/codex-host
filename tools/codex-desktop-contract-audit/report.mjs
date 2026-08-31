export const AUDIT_REPORT_SCHEMA_VERSION = 1;
export const AUDIT_VERDICTS = Object.freeze([
  "no-impact",
  "confirmed-impact",
  "possible-impact",
  "unverified",
]);

export const AUDIT_SURFACE_IDS = Object.freeze([
  "composer",
  "model",
  "permission",
  "request-prewarm",
  "title",
  "settings",
  "sidebar",
  "transcript",
  "usage-credits",
  "fork",
]);

const verdictRank = Object.freeze({
  "no-impact": 0,
  unverified: 1,
  "possible-impact": 2,
  "confirmed-impact": 3,
});

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}

function boundedText(value, label, maximum = 128) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be bounded text`);
  }
  return value;
}

function optionalBoundedText(value, label, maximum = 128) {
  if (value === null) return null;
  return boundedText(value, label, maximum);
}

function integer(value, label) {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function validateEvidence(value, label) {
  exactKeys(value, ["static", "liveStructure", "installation", "behavior"], label);
  const allowed = ["pass", "fail", "changed", "not-run", "inactive"];
  const result = {};
  for (const key of ["static", "liveStructure", "installation", "behavior"]) {
    if (!allowed.includes(value[key])) throw new Error(`${label}.${key} is invalid`);
    result[key] = value[key];
  }
  return result;
}

function validateSurface(value, index) {
  exactKeys(
    value,
    ["id", "verdict", "reason", "evidence", "observed", "baselineChanged"],
    `surface ${index}`,
  );
  const id = boundedText(value.id, `surface ${index}.id`, 64);
  if (!AUDIT_SURFACE_IDS.includes(id)) throw new Error(`surface ${index}.id is unknown`);
  if (!AUDIT_VERDICTS.includes(value.verdict))
    throw new Error(`surface ${index}.verdict is invalid`);
  if (typeof value.baselineChanged !== "boolean")
    throw new Error(`surface ${index}.baselineChanged is invalid`);
  if (!isRecord(value.observed)) throw new Error(`surface ${index}.observed must be an object`);
  const observed = {};
  for (const [key, observedValue] of Object.entries(value.observed)) {
    if (!/^[a-z][a-zA-Z0-9]{0,63}$/.test(key))
      throw new Error(`surface ${index}.observed key is invalid`);
    if (typeof observedValue === "boolean") observed[key] = observedValue;
    else observed[key] = integer(observedValue, `surface ${index}.observed.${key}`);
  }
  return {
    id,
    verdict: value.verdict,
    reason: boundedText(value.reason, `surface ${index}.reason`, 96),
    evidence: validateEvidence(value.evidence, `surface ${index}.evidence`),
    observed,
    baselineChanged: value.baselineChanged,
  };
}

export function validateAuditReport(value) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "recordedAt",
      "mode",
      "verdict",
      "desktop",
      "browser",
      "checksRun",
      "baseline",
      "surfaces",
    ],
    "audit report",
  );
  if (value.schemaVersion !== AUDIT_REPORT_SCHEMA_VERSION)
    throw new Error("audit report schema is unsupported");
  if (!Number.isFinite(Date.parse(value.recordedAt)))
    throw new Error("audit report timestamp is invalid");
  if (!["read-only", "controlled"].includes(value.mode))
    throw new Error("audit report mode is invalid");
  if (!AUDIT_VERDICTS.includes(value.verdict)) throw new Error("audit report verdict is invalid");
  exactKeys(value.desktop, ["version", "build", "asarIntegrity"], "audit report desktop");
  exactKeys(value.browser, ["browser", "protocolVersion"], "audit report browser");
  exactKeys(value.baseline, ["supplied", "version", "build"], "audit report baseline");
  if (typeof value.baseline.supplied !== "boolean")
    throw new Error("audit report baseline flag is invalid");
  if (
    !Array.isArray(value.checksRun) ||
    value.checksRun.some((item) => typeof item !== "string" || item.length > 64)
  ) {
    throw new Error("audit report checksRun is invalid");
  }
  if (!Array.isArray(value.surfaces) || value.surfaces.length !== AUDIT_SURFACE_IDS.length) {
    throw new Error("audit report surfaces are incomplete");
  }
  const surfaces = value.surfaces.map(validateSurface);
  if (new Set(surfaces.map(({ id }) => id)).size !== AUDIT_SURFACE_IDS.length) {
    throw new Error("audit report surfaces must be unique");
  }
  const report = {
    schemaVersion: AUDIT_REPORT_SCHEMA_VERSION,
    recordedAt: new Date(value.recordedAt).toISOString(),
    mode: value.mode,
    verdict: value.verdict,
    desktop: {
      version: boundedText(value.desktop.version, "audit report desktop.version", 64),
      build: boundedText(value.desktop.build, "audit report desktop.build", 64),
      asarIntegrity: boundedText(
        value.desktop.asarIntegrity,
        "audit report desktop.asarIntegrity",
        80,
      ),
    },
    browser: {
      browser: boundedText(value.browser.browser, "audit report browser.browser", 96),
      protocolVersion: boundedText(
        value.browser.protocolVersion,
        "audit report browser.protocolVersion",
        32,
      ),
    },
    checksRun: [...new Set(value.checksRun)],
    baseline: {
      supplied: value.baseline.supplied,
      version: optionalBoundedText(value.baseline.version, "audit report baseline.version", 64),
      build: optionalBoundedText(value.baseline.build, "audit report baseline.build", 64),
    },
    surfaces,
  };
  if (aggregateVerdict(surfaces) !== report.verdict)
    throw new Error("audit report aggregate verdict is inconsistent");
  return report;
}

export function aggregateVerdict(surfaces) {
  return surfaces.reduce(
    (current, surface) =>
      verdictRank[surface.verdict] > verdictRank[current] ? surface.verdict : current,
    "no-impact",
  );
}

function stateForUnique(count, active) {
  if (!active) return "inactive";
  if (count === 1) return "pass";
  return "fail";
}

function baselineSurface(baseline, id) {
  return baseline?.surfaces?.find((surface) => surface.id === id) ?? null;
}

function compareObserved(baseline, id, observed) {
  const previous = baselineSurface(baseline, id);
  return previous !== null && JSON.stringify(previous.observed) !== JSON.stringify(observed);
}

function classifySurface({
  id,
  observed,
  live,
  installation = "not-run",
  behavior = "not-run",
  active = true,
  reason,
  baseline,
}) {
  const baselineChanged = compareObserved(baseline, id, observed);
  let verdict;
  let finalReason = reason;
  if (!active) {
    verdict = baselineChanged ? "possible-impact" : "unverified";
    finalReason = baselineChanged ? "baseline-changed-without-active-state" : reason;
  } else if (live === "fail" || installation === "fail" || behavior === "fail") {
    verdict = "confirmed-impact";
  } else if (baselineChanged) {
    verdict = "possible-impact";
    finalReason = "normalized-contract-changed";
  } else {
    verdict = "no-impact";
  }
  return {
    id,
    verdict,
    reason: finalReason,
    evidence: {
      static: baseline ? (baselineChanged ? "changed" : "pass") : "not-run",
      liveStructure: live,
      installation,
      behavior,
    },
    observed,
    baselineChanged,
  };
}

export function buildSurfaceResults(contracts, baseline = null, controlled = null) {
  const activeComposer = contracts.composer.activeComposerCount === 1;
  const composer = classifySurface({
    id: "composer",
    observed: {
      composerCount: contracts.composer.composerCount,
      visibleComposerCount: contracts.composer.visibleComposerCount,
      activeComposerCount: contracts.composer.activeComposerCount,
      sendButtonCount: contracts.composer.sendButtonCount,
      trailingActionOwnerCount: contracts.composer.trailingActionOwnerCount,
    },
    live: stateForUnique(
      contracts.composer.activeComposerCount,
      contracts.composer.visibleComposerCount > 0,
    ),
    active: contracts.composer.visibleComposerCount > 0,
    reason:
      contracts.composer.visibleComposerCount > 0
        ? "active-composer-cardinality"
        : "composer-state-not-visible",
    baseline,
  });
  const modelResolved = contracts.model.draftCount + contracts.model.conversationCount;
  const model = classifySurface({
    id: "model",
    observed: {
      resolvedTargetCount: modelResolved,
      missingCount: contracts.model.missingCount,
      ambiguousCount: contracts.model.ambiguousCount,
      verifiedTriggerCount: contracts.composer.verifiedModelCandidateCount,
    },
    live:
      activeComposer && modelResolved === 1 && contracts.model.ambiguousCount === 0
        ? "pass"
        : activeComposer
          ? "fail"
          : "inactive",
    active: activeComposer,
    reason: activeComposer ? "composer-model-target" : "composer-state-not-active",
    baseline,
  });
  const permissionActive = contracts.composer.permissionCandidateCount > 0;
  const permission = classifySurface({
    id: "permission",
    observed: {
      candidateCount: contracts.composer.permissionCandidateCount,
      verifiedCount: contracts.composer.verifiedPermissionCandidateCount,
    },
    live: stateForUnique(contracts.composer.verifiedPermissionCandidateCount, permissionActive),
    active: permissionActive,
    reason: permissionActive ? "permission-owner-cardinality" : "permission-control-state-inactive",
    baseline,
  });
  const installationRequested = controlled !== null;
  const requestInstallation = installationRequested
    ? controlled.draftPrewarmPolicyState === "ready" && controlled.adapterState === "ready"
      ? "pass"
      : "fail"
    : contracts.production.bindingPresent
      ? contracts.production.draftPrewarmPolicyState === "ready" &&
        contracts.production.adapterState === "ready"
        ? "pass"
        : "fail"
      : "not-run";
  const request = classifySurface({
    id: "request-prewarm",
    observed: {
      bindingPresent: contracts.production.bindingPresent,
      adapterReady: contracts.production.adapterState === "ready",
      draftPrewarmReady: contracts.production.draftPrewarmPolicyState === "ready",
    },
    live: activeComposer ? "pass" : "inactive",
    installation: requestInstallation,
    active: activeComposer,
    reason: activeComposer ? "request-prewarm-observation" : "composer-state-not-active",
    baseline,
  });
  const titleInstallation = installationRequested
    ? controlled.titlePolicyState === "ready"
      ? "pass"
      : "fail"
    : contracts.production.bindingPresent
      ? contracts.production.titlePolicyState === "ready"
        ? "pass"
        : "fail"
      : "not-run";
  const effectiveTitleReady =
    controlled?.titlePolicyState === "ready" || contracts.production.titlePolicyState === "ready";
  const title = classifySurface({
    id: "title",
    observed: { titlePolicyReady: effectiveTitleReady },
    live: effectiveTitleReady ? "pass" : "inactive",
    installation: titleInstallation,
    behavior: controlled?.titleBehavior ?? "not-run",
    active: contracts.production.bindingPresent || installationRequested,
    reason:
      contracts.production.bindingPresent || installationRequested
        ? "title-policy-observation"
        : "title-policy-not-installed",
    baseline,
  });
  const settingsActive = contracts.settings.visibleHeaderCount > 0;
  const settings = classifySurface({
    id: "settings",
    observed: contracts.settings,
    live: stateForUnique(contracts.settings.insertionPointCount, settingsActive),
    behavior: controlled?.settingsBehavior ?? "not-run",
    active: settingsActive,
    reason: settingsActive ? "settings-insertion-cardinality" : "application-header-state-inactive",
    baseline,
  });
  const sidebarActive = contracts.sidebar.rowCount > 0;
  const sidebar = classifySurface({
    id: "sidebar",
    observed: contracts.sidebar,
    live:
      sidebarActive &&
      contracts.sidebar.ambiguousThreadCount === 0 &&
      contracts.sidebar.titleOwnerCount === contracts.sidebar.rowCount
        ? "pass"
        : sidebarActive
          ? "fail"
          : "inactive",
    active: sidebarActive,
    reason: sidebarActive ? "sidebar-row-ownership" : "sidebar-thread-state-inactive",
    baseline,
  });
  // Codex retains transcript text for the Command Execution lane only, and that
  // is the lane external Harness Reasoning is projected through. Item nodes must
  // keep publishing their Host Item ids, and the text-body counts ride the
  // baseline so a Desktop update that drops the lane is not silently invisible.
  const transcriptActive = contracts.transcript.itemNodeCount > 0;
  const transcript = classifySurface({
    id: "transcript",
    observed: contracts.transcript,
    live:
      transcriptActive &&
      contracts.transcript.identifiedItemCount >= contracts.transcript.itemNodeCount
        ? "pass"
        : transcriptActive
          ? "fail"
          : "inactive",
    active: transcriptActive,
    reason: transcriptActive ? "transcript-item-id-publication" : "transcript-item-state-inactive",
    baseline,
  });
  const usageActive = contracts.composer.contextUsageCandidateCount > 0;
  const usageCredits = classifySurface({
    id: "usage-credits",
    observed: {
      candidateCount: contracts.composer.contextUsageCandidateCount,
      verifiedCount: contracts.composer.verifiedContextUsageCandidateCount,
    },
    live: stateForUnique(contracts.composer.verifiedContextUsageCandidateCount, usageActive),
    active: usageActive,
    reason: usageActive ? "context-usage-owner-cardinality" : "usage-control-state-inactive",
    baseline,
  });
  const forkActive = contracts.fork.annotatedResponseCount > 0;
  const fork = classifySurface({
    id: "fork",
    observed: contracts.fork,
    live:
      forkActive && contracts.fork.verifiedButtonCount > 0
        ? "pass"
        : forkActive
          ? "fail"
          : "inactive",
    behavior: controlled?.forkBehavior ?? "not-run",
    active: forkActive,
    reason: forkActive ? "fork-owner-cardinality" : "fork-surface-state-inactive",
    baseline,
  });
  return [
    composer,
    model,
    permission,
    request,
    title,
    settings,
    sidebar,
    transcript,
    usageCredits,
    fork,
  ];
}

export function auditReportMarkdown(report) {
  const lines = [
    `# Codex Desktop contract audit`,
    "",
    `**Verdict:** ${report.verdict}`,
    `**Mode:** ${report.mode}`,
    `**Desktop:** ${report.desktop.version} (${report.desktop.build})`,
    `**Browser:** ${report.browser.browser}; protocol ${report.browser.protocolVersion}`,
    `**Reviewed baseline:** ${report.baseline.supplied ? `${report.baseline.version} (${report.baseline.build})` : "not supplied"}`,
    "",
    "| Surface | Verdict | Reason | Structure | Installation | Behavior |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const surface of report.surfaces) {
    lines.push(
      `| ${surface.id} | ${surface.verdict} | ${surface.reason} | ${surface.evidence.liveStructure} | ${surface.evidence.installation} | ${surface.evidence.behavior} |`,
    );
  }
  lines.push("", `Checks run: ${report.checksRun.join(", ") || "none"}`, "");
  return `${lines.join("\n")}\n`;
}
