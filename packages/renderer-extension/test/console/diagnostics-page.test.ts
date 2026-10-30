import { describe, expect, it, vi } from "vitest";

import { failedStep, renderStartupDiagnostics } from "../../src/console/pages/diagnostics.js";
import { consoleMessages } from "../../src/console/messages.js";
import { ConsoleState, type ConsoleOverview } from "../../src/console/state.js";
import { createOverviewPage } from "../../src/console/pages/overview.js";
import type { RendererSettingsPageMountContext } from "../../src/settings/core.js";

vi.mock("../../src/settings/icons.js", () => ({ createRendererSettingsIcon: () => null }));

vi.mock("../../src/console/dom.js", () => ({
  formatTime: () => "12:00",
  button: (_document: Document, label: unknown) => ({ tag: "button", label }),
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
    console: { version: "0.10.2", distribution: null },
    inspect: null,
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

function renderOverview(value: ConsoleOverview): string {
  const state = new ConsoleState();
  state.overview = value;
  const replaceChildren = vi.fn();
  const context = {
    content: { ownerDocument: {}, replaceChildren },
  } as unknown as RendererSettingsPageMountContext;
  createOverviewPage(consoleMessages("zh-CN"), state, vi.fn(), "zh-CN").mount(context);
  return JSON.stringify(replaceChildren.mock.calls.at(-1));
}

describe("overview startup diagnostics", () => {
  it("shows starting without a launch button, and enables retry only after failure", () => {
    const state = new ConsoleState();
    state.overview = overview();
    state.overview.summary.state = "starting";
    const latest = state.overview.startup[0];
    if (!latest) throw new Error("Missing fixture startup");
    latest.outcome = "starting";
    const replaceChildren = vi.fn();
    let refresh: (() => void) | undefined;
    vi.spyOn(state, "subscribe").mockImplementation((listener) => {
      refresh = listener;
      return () => undefined;
    });
    const context = {
      content: { ownerDocument: {}, replaceChildren },
    } as unknown as RendererSettingsPageMountContext;
    createOverviewPage(consoleMessages("zh-CN"), state, vi.fn(), "zh-CN").mount(context);
    const initial = JSON.stringify(replaceChildren.mock.calls.at(-1));
    expect(initial).toContain("codexhost 正在启动");
    expect(initial).not.toContain('"tag":"button"');
    expect(initial).not.toContain("启动成功");
    expect(initial).not.toContain("codexhost 未运行");

    state.overview.summary = { state: "startup-failed", detail: "failed to start" };
    latest.outcome = "failed";
    refresh?.();
    const failed = JSON.stringify(replaceChildren.mock.calls.at(-1));
    expect(failed).toContain('"tag":"button"');
    expect(failed).toContain("启动 codexhost");

    state.overview.summary = { state: "running", detail: null };
    latest.outcome = "ready";
    refresh?.();
    const ready = JSON.stringify(replaceChildren.mock.calls.at(-1));
    expect(ready).toContain("codexhost 正在运行");
    expect(ready).not.toContain('"tag":"button"');
  });

  it("does not present an abandoned starting record as a successful startup", () => {
    const value = overview();
    const latest = value.startup[0];
    if (!latest) throw new Error("Missing fixture startup");
    latest.outcome = "starting";
    value.summary.state = "startup-failed";
    expect(render(value)).toContain("本次启动未完成");
    expect(render(value)).not.toContain("启动成功");
  });

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

  it("displays portable desktop source, path, and version unknown fallback in overview", () => {
    const state = new ConsoleState();
    state.overview = overview();
    state.overview.inspect = {
      desktop: {
        platform: "windows",
        identity: {
          packageName: "OpenAI.Codex",
          packageFamilyName: "OpenAI.Codex_portable",
          appxActivation: null,
        },
        version: "unknown",
        build: "unknown",
        installRoot: "E:\\Develop\\codex\\versions\\current",
      },
      desktopError: null,
      runtime: { running: true },
    };
    const replaceChildren = vi.fn();
    const context = {
      content: { ownerDocument: {}, replaceChildren },
    } as unknown as RendererSettingsPageMountContext;
    createOverviewPage(consoleMessages("zh-CN"), state, vi.fn(), "zh-CN").mount(context);
    const rendered = JSON.stringify(replaceChildren.mock.calls.at(-1));
    expect(rendered).toContain("绿色便携版");
    expect(rendered).toContain("版本未知");
    expect(rendered).not.toContain("0.0.0.0");
    expect(rendered).toContain("E:\\\\Develop\\\\codex\\\\versions\\\\current");
  });

  it("displays msix desktop source and valid version in overview", () => {
    const state = new ConsoleState();
    state.overview = overview();
    state.overview.inspect = {
      desktop: {
        platform: "windows",
        identity: {
          packageName: "OpenAI.Codex",
          packageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
          appxActivation: {
            packageFullName: "OpenAI.Codex_26.1021.2667.0_x64__2p2nqsd0c76g0",
            appUserModelId: "OpenAI.Codex_2p2nqsd0c76g0!App",
          },
        },
        version: "26.1021.2667.0",
        build: "26.1021.2667.0",
        installRoot: "C:\\Program Files\\WindowsApps\\OpenAI.Codex",
      },
      desktopError: null,
      runtime: { running: true },
    };
    const replaceChildren = vi.fn();
    const context = {
      content: { ownerDocument: {}, replaceChildren },
    } as unknown as RendererSettingsPageMountContext;
    createOverviewPage(consoleMessages("zh-CN"), state, vi.fn(), "zh-CN").mount(context);
    const rendered = JSON.stringify(replaceChildren.mock.calls.at(-1));
    expect(rendered).toContain("MSIX 已注册包");
    expect(rendered).toContain("26.1021.2667.0");
  });

  it("omits the desktop source when an older Launcher has no appxActivation field", () => {
    const value = overview();
    value.inspect = {
      desktop: {
        platform: "windows",
        identity: {
          packageName: "OpenAI.Codex",
          packageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
        },
        version: "26.1021.2667.0",
        build: "26.1021.2667.0",
        installRoot: "C:\\Program Files\\WindowsApps\\OpenAI.Codex",
      },
      desktopError: null,
      runtime: { running: true },
    };
    const rendered = renderOverview(value);
    expect(rendered).toContain("26.1021.2667.0");
    expect(rendered).not.toContain("绿色便携版");
    expect(rendered).not.toContain("MSIX 已注册包");
    expect(rendered).not.toContain("Codex Desktop 来源");

    // A missing identity is unknown too, not a portable installation.
    value.inspect = {
      desktop: {
        platform: "windows",
        version: "26.1021.2667.0",
        build: "26.1021.2667.0",
        installRoot: "C:\\Program Files\\WindowsApps\\OpenAI.Codex",
      },
      desktopError: null,
      runtime: { running: true },
    };
    expect(renderOverview(value)).not.toContain("Codex Desktop 来源");
  });

  it("replaces historical 0.0.0.0 with version unknown in diagnostics", () => {
    const value = overview();
    const latest = value.startup[0];
    if (!latest) throw new Error("Missing fixture startup");
    latest.outcome = "failed";
    latest.desktop = {
      version: "0.0.0.0",
      build: "0.0.0.0",
      installRoot: "E:\\Develop\\codex",
    };
    const output = render(value);
    expect(output).toContain("版本未知");
    expect(output).not.toContain("0.0.0.0");
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
