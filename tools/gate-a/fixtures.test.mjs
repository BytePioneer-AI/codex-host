import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  desktopInteractiveEvidenceSchema,
  macosDifferentialSummarySchema,
  macosLifecycleSummarySchema,
  probeInvocationSchema,
} from "./contracts.mjs";

const fixtureRoot = path.resolve(import.meta.dirname, "../../tests/fixtures/gate-a");

function readFixture(name, platform = "windows") {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, platform, name), "utf8"));
}

function expectPrivacyReviewed(value) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toMatch(/[A-Z]:\\Users\\/u);
  expect(serialized).not.toMatch(/Administrator/u);
  expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9._-]+/iu);
  expect(serialized).not.toMatch(/api[_-]?key["'=:\s]+[A-Za-z0-9._-]+/iu);
  expect(serialized).not.toMatch(/\/Users\/[A-Za-z0-9._-]+\//u);
  expect(serialized).not.toMatch(/\/private\/var\/folders\//u);
}

describe("reviewed Gate A fixtures", () => {
  it("records the reviewed Desktop-to-Shim invocation", () => {
    const fixture = probeInvocationSchema.parse(
      readFixture("desktop-shim-invocation.fixture.json"),
    );
    expect(fixture).toMatchObject({
      platform: "windows",
      invocationKind: "app-server",
      args: ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"],
      environmentPresence: {
        CODEX_CLI_PATH: true,
        CODEXHOST_STOCK_CODEX_PATH: true,
      },
    });
    expect(fixture.processId).not.toBe(fixture.parentProcessId);
    expectPrivacyReviewed(fixture);
  });

  it("records reviewed Desktop interaction and lifecycle outcomes", () => {
    const fixture = desktopInteractiveEvidenceSchema.parse(
      readFixture("desktop-interactive.fixture.json"),
    );
    expect(fixture.platform).toBe("windows");
    expect(Object.values(fixture.scenarios).every(Boolean)).toBe(true);
    expectPrivacyReviewed(fixture);
  });

  it("retains only reviewed app-server envelope shapes", () => {
    const fixture = readFixture("official-app-server.fixture.json");
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      transport: "LF-delimited JSON objects over stdio",
    });
    expect(fixture.requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "model/list",
      "thread/list",
      "thread/start",
      "thread/read",
      "thread/resume",
      "codexhost/unknown-method",
    ]);
    expect(fixture.responseShapes[1].result.data).toBe("<DYNAMIC_MODEL_CATALOG>");
    expectPrivacyReviewed(fixture);
  });

  it("records the reviewed macOS Desktop-to-Shim invocation", () => {
    const fixture = probeInvocationSchema.parse(
      readFixture("desktop-shim-invocation.fixture.json", "macos"),
    );
    expect(fixture).toMatchObject({
      platform: "macos",
      architecture: "aarch64",
      launchMode: "launch-services",
      invocationKind: "app-server",
      args: ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"],
      environmentPresence: {
        CODEX_CLI_PATH: true,
        CODEXHOST_STOCK_CODEX_PATH: true,
      },
    });
    expectPrivacyReviewed(fixture);
  });

  it("records a reviewed macOS non-live differential without sensitive payloads", () => {
    const fixture = readFixture("official-cli-differential-non-live.fixture.json", "macos");
    expect(fixture).toMatchObject({
      platform: "macos",
      architecture: "arm64",
      byteLayerEqual: true,
      unknownDifferences: [],
    });
    expect(fixture.protocolScenarios).toHaveLength(7);
    expect(fixture.protocolScenarios.every((scenario) => scenario.equal)).toBe(true);
    expectPrivacyReviewed(fixture);
  });

  it("records a reviewed macOS live differential without sensitive payloads", () => {
    const fixture = macosDifferentialSummarySchema.parse(
      readFixture("official-cli-differential-live.fixture.json", "macos"),
    );
    expect(fixture.byteLayerEqual).toBe(true);
    expect(fixture.unknownDifferences).toEqual([]);
    expect(fixture.protocolScenarios).toHaveLength(10);
    expect(fixture.protocolScenarios.every((scenario) => scenario.equal)).toBe(true);
    for (const scenario of fixture.protocolScenarios.filter(({ name }) =>
      name.startsWith("live"),
    )) {
      expect(scenario.directPassed).toBe(true);
      expect(scenario.shimPassed).toBe(true);
    }
    expectPrivacyReviewed(fixture);
  });

  it("records reviewed macOS Desktop interaction outcomes", () => {
    const fixture = desktopInteractiveEvidenceSchema.parse(
      readFixture("desktop-interactive.fixture.json", "macos"),
    );
    expect(fixture).toMatchObject({
      platform: "macos",
      architecture: "arm64",
      launchMode: "launch-services",
    });
    expect(Object.values(fixture.scenarios).every(Boolean)).toBe(true);
    expectPrivacyReviewed(fixture);
  });

  it("records reviewed macOS lifecycle outcomes without unresolved blockers", () => {
    const fixture = macosLifecycleSummarySchema.parse(
      readFixture("lifecycle-summary.fixture.json", "macos"),
    );
    expect(Object.values(fixture.scenarios).every(Boolean)).toBe(true);
    expect(fixture.blockedScenarios).toEqual([]);
    expectPrivacyReviewed(fixture);
  });

  it("records a zero-difference official CLI summary", () => {
    const fixture = readFixture("official-cli-differential.fixture.json");
    expect(fixture.byteLayerEqual).toBe(true);
    expect(fixture.unknownDifferences).toEqual([]);
    expect(fixture.protocolScenarios).toHaveLength(10);
    expect(fixture.protocolScenarios.every((scenario) => scenario.equal)).toBe(true);
    expectPrivacyReviewed(fixture);
  });
});
