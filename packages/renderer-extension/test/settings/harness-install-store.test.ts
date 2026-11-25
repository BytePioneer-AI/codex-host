import { describe, expect, it, vi } from "vitest";
import { harnessInstallStore } from "../../src/settings/harness-install-store.js";
import type {
  RendererConnectionDiagnostics,
  RendererConnectionSnapshot,
} from "../../src/settings/connections-page.js";

function snapshot(
  availability: "ready" | "notInstalled" | "error" | "unavailable" = "notInstalled",
  hostId = "local",
): RendererConnectionSnapshot {
  return {
    adapter: { state: "ready", reason: "ready", modelUpdates: 1, hook: "request-bridge" },
    hosts: [{ hostId, active: true, agents: [{ agent: "pi", availability, error: null }] }],
  };
}

const state = {
  currentVersion: "1.0.0",
  latestVersion: "1.0.0",
  updateAvailable: false,
  canUpdate: true,
};
describe("connection-owned install state", () => {
  it("uses the refreshed ready status after a version readback failure", async () => {
    let current = snapshot();
    const diagnostics = {
      snapshot: () => current,
      installation: vi.fn(async () => {
        throw new Error("Version readback failed");
      }),
      refresh: vi.fn(async () => {
        current = snapshot("ready");
      }),
    } as unknown as RendererConnectionDiagnostics;
    const store = harnessInstallStore(diagnostics);
    await store.install("local", "pi");
    expect(store.get("local", "pi")).toBeUndefined();
  });

  it.each(["notInstalled", "error", "unavailable"] as const)(
    "retains installation failure when refreshed availability is %s",
    async (availability) => {
      const diagnostics = {
        snapshot: () => snapshot(availability),
        installation: vi.fn(async () => {
          throw new Error("Install failed");
        }),
        refresh: vi.fn(async () => undefined),
      } as unknown as RendererConnectionDiagnostics;
      const store = harnessInstallStore(diagnostics);
      await store.install("local", "pi");
      expect(store.get("local", "pi")).toEqual({ status: "error", error: "Install failed" });
    },
  );

  it("does not use a different Host's ready state or a stale snapshot after refresh failure", async () => {
    const diagnostics = {
      snapshot: () => snapshot("ready", "remote"),
      installation: vi.fn(async () => {
        throw new Error("Install failed");
      }),
      refresh: vi.fn(async () => undefined),
    } as unknown as RendererConnectionDiagnostics;
    const store = harnessInstallStore(diagnostics);
    await store.install("local", "pi");
    expect(store.get("local", "pi")?.status).toBe("error");
    vi.mocked(diagnostics.refresh).mockRejectedValueOnce(new Error("Refresh failed"));
    await store.install("remote", "pi");
    expect(store.get("remote", "pi")?.status).toBe("error");
  });
  it("survives page subscriptions, isolates Hosts, coalesces clicks and refreshes before clearing", async () => {
    const result = Promise.withResolvers<typeof state>();
    const refreshed = Promise.withResolvers<undefined>();
    const diagnostics = {
      snapshot: () => snapshot(),
      installation: vi.fn(() => result.promise),
      refresh: vi.fn(() => refreshed.promise),
    } as unknown as RendererConnectionDiagnostics;
    const store = harnessInstallStore(diagnostics);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const pending = store.install("remote", "pi");
    await store.install("remote", "pi");
    expect(diagnostics.installation).toHaveBeenCalledExactlyOnceWith("remote", "pi", "install");
    expect(store.get("remote", "pi")?.status).toBe("installing");
    expect(store.get("local", "pi")).toBeUndefined();
    unsubscribe();
    expect(harnessInstallStore(diagnostics)).toBe(store);
    result.resolve(state);
    await vi.waitFor(() => expect(store.get("remote", "pi")?.status).toBe("checking"));
    expect(diagnostics.refresh).toHaveBeenCalledExactlyOnceWith("remote");
    refreshed.resolve(undefined);
    await pending;
    expect(store.get("remote", "pi")).toBeUndefined();
    expect(listener).toHaveBeenCalledOnce();
  });
  it("keeps errors for the inspector, refreshes even after failure and permits retry", async () => {
    const diagnostics = {
      snapshot: () => snapshot(),
      installation: vi
        .fn(async () => state)
        .mockRejectedValueOnce(new Error("Installation failed")),
      refresh: vi.fn(async () => undefined),
    } as unknown as RendererConnectionDiagnostics;
    const store = harnessInstallStore(diagnostics);
    await store.install("local", "pi");
    expect(store.get("local", "pi")).toEqual({ status: "error", error: "Installation failed" });
    expect(diagnostics.refresh).toHaveBeenCalledExactlyOnceWith("local");
    await store.install("local", "pi");
    expect(store.get("local", "pi")).toBeUndefined();
  });
});
