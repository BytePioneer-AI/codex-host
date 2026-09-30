import { describe, expect, it, vi } from "vitest";

import { createConsoleConnectionDiagnostics } from "../../src/console/connection-diagnostics.js";
import type { RendererModelClient } from "../../src/renderer-model-client.js";

function client(overrides: Partial<RendererModelClient>): RendererModelClient {
  return overrides as RendererModelClient;
}

describe("console connection diagnostics", () => {
  it("derives availability, errors and Web UI from Harness inspections", async () => {
    const inspectHarness = vi.fn(async ({ harnessId }: { harnessId: string }) => {
      if (harnessId === "pi") return { status: "ready", webUi: { open: true } };
      if (harnessId === "grok") {
        return {
          status: "notInstalled",
          error: { code: "notInstalled", message: "grok was not found", retryable: false },
        };
      }
      throw new Error("Host request failed");
    });
    const diagnostics = createConsoleConnectionDiagnostics(
      client({ inspectHarness: inspectHarness as never }),
    );
    const updates = vi.fn();
    diagnostics.subscribe(updates);

    const initial = diagnostics.snapshot();
    expect(initial.hosts).toHaveLength(1);
    expect(initial.hosts[0]?.agents.every((agent) => agent.availability === "checking")).toBe(true);
    await vi.waitFor(() =>
      expect(
        diagnostics.snapshot().hosts[0]?.agents.some((agent) => agent.availability === "checking"),
      ).toBe(false),
    );

    const agents = new Map(
      diagnostics.snapshot().hosts[0]?.agents.map((agent) => [agent.agent, agent]),
    );
    expect(agents.get("pi")).toMatchObject({
      availability: "ready",
      error: null,
      webUiAvailable: true,
    });
    expect(agents.get("grok")).toMatchObject({
      availability: "notInstalled",
      error: { message: "grok was not found" },
    });
    expect(agents.get("hermes")).toMatchObject({
      availability: "error",
      error: { message: "Host request failed", stage: "request" },
    });
    expect(inspectHarness).toHaveBeenCalledWith({ harnessId: "pi", refresh: false });
    expect(updates).toHaveBeenCalled();

    await diagnostics.refresh();
    expect(inspectHarness).toHaveBeenCalledWith({ harnessId: "pi", refresh: true });
  });

  it("uses the Host for launch settings and Web UI", async () => {
    const getHarnessLaunchSettings = vi.fn(async () => ({ path: null, restartRequired: false }));
    const setHarnessLaunchSettings = vi.fn(async () => ({
      path: "/opt/pi",
      restartRequired: true,
    }));
    const openHarnessWebUi = vi.fn(async () => ({}));
    const diagnostics = createConsoleConnectionDiagnostics(
      client({
        inspectHarness: vi.fn(async () => ({ status: "ready" })) as never,
        getHarnessLaunchSettings: getHarnessLaunchSettings as never,
        setHarnessLaunchSettings: setHarnessLaunchSettings as never,
        openHarnessWebUi: openHarnessWebUi as never,
      }),
    );
    await diagnostics.getLaunchSettings?.("local", "pi");
    await diagnostics.setLaunchSettings?.("local", "pi", "/opt/pi");
    await diagnostics.openWebUi?.("local", "pi");
    expect(getHarnessLaunchSettings).toHaveBeenCalledWith({ harnessId: "pi" });
    expect(setHarnessLaunchSettings).toHaveBeenCalledWith({ harnessId: "pi", path: "/opt/pi" });
    expect(openHarnessWebUi).toHaveBeenCalledWith({ harnessId: "pi" });
  });
});
