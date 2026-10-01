import { describe, expect, it, vi } from "vitest";
import { harnessInstallStore } from "../../src/settings/harness-install-store.js";
import type { RendererConnectionDiagnostics } from "../../src/settings/connections-page.js";

const state = {
  currentVersion: "1.0.0",
  latestVersion: "1.0.0",
  updateAvailable: false,
  canUpdate: true,
};
describe("connection-owned install state", () => {
  it("survives page subscriptions, isolates Hosts, coalesces clicks and refreshes before clearing", async () => {
    const result = Promise.withResolvers<typeof state>();
    const refreshed = Promise.withResolvers<undefined>();
    const diagnostics = {
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
    refreshed.resolve(undefined);
    await pending;
    expect(store.get("remote", "pi")).toBeUndefined();
    expect(listener).toHaveBeenCalledOnce();
  });
  it("keeps errors for the inspector, refreshes even after failure and permits retry", async () => {
    const diagnostics = {
      installation: vi
        .fn(async () => state)
        .mockRejectedValueOnce(new Error("Installation failed")),
      refresh: vi.fn(async () => undefined),
    } as unknown as RendererConnectionDiagnostics;
    const store = harnessInstallStore(diagnostics);
    await store.install("local", "pi");
    expect(store.get("local", "pi")).toEqual({ status: "error", error: "Installation failed" });
    expect(diagnostics.refresh).toHaveBeenCalledOnce();
    await store.install("local", "pi");
    expect(store.get("local", "pi")).toBeUndefined();
  });
});
