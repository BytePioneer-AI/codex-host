import { describe, expect, it, vi } from "vitest";
import { harnessIdSchema } from "@codexhost/shared-contracts";

import { createConsoleConnectionDiagnostics } from "../../src/console/connection-diagnostics.js";
import type { RendererModelClient } from "../../src/renderer-model-client.js";

function client(overrides: Partial<RendererModelClient>): RendererModelClient {
  return {
    listHarnessPlugins: async () => ({
      plugins: [
        ...["pi", "grok", "hermes"].map((id) => ({ id, name: id, version: "1" })),
        { id: "codex-usage", name: "Codex usage", version: "1", kind: "usage" as const },
      ],
    }),
    ...overrides,
  } as RendererModelClient;
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
    await vi.waitFor(() => expect(diagnostics.snapshot().hosts[0]?.agents).toHaveLength(3));
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
    expect(inspectHarness).toHaveBeenCalledWith({
      harnessId: "pi",
      refresh: false,
      purpose: "availability",
    });
    expect(updates).toHaveBeenCalled();

    await diagnostics.refresh();
    expect(inspectHarness).toHaveBeenCalledWith({
      harnessId: "pi",
      refresh: true,
      purpose: "availability",
    });
  });

  it.each([1, 3])(
    "queues one manual refresh for %s clicks during a background check",
    async (clicks) => {
      const background = Promise.withResolvers<never>();
      const refreshed = Promise.withResolvers<never>();
      const inspectHarness = vi
        .fn()
        .mockReturnValueOnce(background.promise)
        .mockReturnValueOnce(refreshed.promise);
      const diagnostics = createConsoleConnectionDiagnostics(
        client({
          listHarnessPlugins: async () => ({
            plugins: [{ id: harnessIdSchema.parse("pi"), name: "Pi", version: "1" }],
          }),
          inspectHarness,
        }),
      );
      diagnostics.snapshot();
      await vi.waitFor(() => expect(inspectHarness).toHaveBeenCalledTimes(1));
      const refreshes = Array.from({ length: clicks }, () =>
        diagnostics.refresh(undefined, "retry"),
      );
      expect(inspectHarness).toHaveBeenCalledExactlyOnceWith({
        harnessId: "pi",
        refresh: false,
        purpose: "availability",
      });
      background.reject(new Error("background failed"));
      await vi.waitFor(() => expect(inspectHarness).toHaveBeenCalledTimes(2));
      expect(inspectHarness).toHaveBeenLastCalledWith({
        harnessId: "pi",
        refresh: true,
        purpose: "availability",
        credentialAccess: "retry",
      });
      const settled = vi.fn();
      void Promise.all(refreshes).then(settled);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      refreshed.reject(new Error("refresh failed"));
      await Promise.all(refreshes);
      expect(inspectHarness).toHaveBeenCalledTimes(2);
      await diagnostics.refresh();
      expect(inspectHarness).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["install", "check", "update"] as const)(
    "forwards %s to the local Host",
    async (action) => {
      const state = {
        currentVersion: "1.0",
        latestVersion: "1.0",
        updateAvailable: false,
        canUpdate: true,
      };
      const installation = vi.fn(async () => state);
      const diagnostics = createConsoleConnectionDiagnostics(client({ installation }));
      await expect(diagnostics.installation?.("local", "pi", action)).resolves.toEqual(state);
      expect(installation).toHaveBeenCalledExactlyOnceWith({ harnessId: "pi", action });
    },
  );

  it("does not advertise installation when the client lacks the interface", () => {
    expect(createConsoleConnectionDiagnostics(client({})).installation).toBeUndefined();
  });

  it("rejects remote installation without invoking the local Host", async () => {
    const installation = vi.fn();
    const diagnostics = createConsoleConnectionDiagnostics(client({ installation }));
    await expect(diagnostics.installation?.("remote-test", "pi", "install")).rejects.toThrow(
      "only supports the local Host",
    );
    expect(installation).not.toHaveBeenCalled();
  });

  it("preserves Host installation errors", async () => {
    const error = new Error("Installer failed");
    const installation = vi.fn().mockRejectedValue(error);
    const diagnostics = createConsoleConnectionDiagnostics(client({ installation }));
    await expect(diagnostics.installation?.("local", "pi", "install")).rejects.toBe(error);
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
