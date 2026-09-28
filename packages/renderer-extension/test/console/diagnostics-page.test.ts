import { describe, expect, it, vi } from "vitest";

import { failedStep, renderStartupDiagnostics } from "../../src/console/pages/diagnostics.js";
import { consoleMessages } from "../../src/console/messages.js";
import type { ConsoleOverview } from "../../src/console/state.js";

vi.mock("../../src/console/dom.js", () => ({
  formatTime: () => "12:00",
  h: (_document: Document, tag: string, attributes: object, ...children: unknown[]) => ({
    tag,
    attributes,
    children,
    append(...items: unknown[]) {
      children.push(...items);
    },
  }),
}));

function overview(): ConsoleOverview {
  return {
    console: { version: "0.10.2", appDirectory: "", distribution: null },
    homeDirectory: "",
    inspect: null,
    inspectError: null,
    startup: [
      {
        id: "test",
        launcherVersion: "0.10.2",
        startedAtMs: 1,
        outcome: "ready",
        error: null,
        desktop: null,
        stages: [{ name: "resources resolved", elapsedMs: 100 }],
      },
    ],
    controller: null,
    controllerAlive: false,
    logs: [],
    launchAvailable: true,
    summary: { state: "running", detail: null },
    issueUrl: "",
    hostAvailable: false,
  };
}

function render(value: ConsoleOverview): string {
  return JSON.stringify(
    renderStartupDiagnostics({} as Document, consoleMessages("zh-CN"), value, "zh-CN"),
  );
}

describe("overview startup diagnostics", () => {
  it("shows only the latest successful start without timeline or duplicate report actions", () => {
    const value = overview();
    const latest = value.startup[0];
    if (!latest) throw new Error("Missing fixture startup");
    value.startup.push({
      ...latest,
      id: "old",
      error: "old failure",
      outcome: "failed",
    });
    const output = render(value);
    expect(output).toContain("启动成功");
    expect(output).not.toContain("resources resolved");
    expect(output).not.toContain("old failure");
    expect(output).not.toContain("/api/diagnostics/export");
  });

  it("shows the failed step and raw error with details collapsed", () => {
    const value = overview();
    const latest = value.startup[0];
    if (!latest) throw new Error("Missing fixture startup");
    latest.outcome = "failed";
    latest.error = "desktop not found";
    const output = render(value);
    expect(output).toContain("desktop not found");
    expect(output).toContain(consoleMessages("zh-CN").steps.findDesktop);
    expect(output).toContain('"tag":"details"');
    expect(output).not.toContain('"open":');
    expect(output).toContain("resources resolved");
  });

  it("shows integration errors only for a persistent failure", () => {
    const value = overview();
    value.controller = {
      renderer: { state: "unavailable", error: "injection error", failures: 1, updatedAt: 1 },
    };
    expect(render(value)).not.toContain("injection error");
    value.summary.state = "integration-unavailable";
    expect(render(value)).toContain("injection error");
  });
});

const stages = (...names: string[]) => names.map((name) => ({ name }));

describe("startup failure step", () => {
  it("names the step after the last completed stage", () => {
    expect(failedStep(stages("launch requested", "resources resolved"))).toBe("findDesktop");
    expect(failedStep(stages("launching Codex Desktop", "Codex Desktop launched"))).toBe(
      "connectDesktop",
    );
    expect(failedStep(stages("Desktop Controller ready"))).toBe("startHost");
  });

  it("names the step of a stage that was still waiting", () => {
    expect(failedStep(stages("waiting for Desktop Controller readiness"))).toBe("connectDesktop");
    expect(failedStep(stages("waiting for Host chain"))).toBe("startHost");
  });

  it("falls back to preparation for unknown or missing stages", () => {
    expect(failedStep([])).toBe("prepare");
    expect(failedStep(stages("a future stage"))).toBe("prepare");
  });
});
