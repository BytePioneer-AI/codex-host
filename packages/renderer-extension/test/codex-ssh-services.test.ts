import { describe, expect, it, vi } from "vitest";
import { loadCodexSshServices } from "../src/codex-ssh-services.js";

function owner(...urls: string[]): Window {
  return {
    location: { href: "app://-/index.html" },
    document: {
      querySelectorAll: () => urls.map((url) => ({ getAttribute: () => url })),
    },
  } as unknown as Window;
}

function services() {
  return {
    sshConnections: { refresh: vi.fn(), save: vi.fn() },
    remoteConnections: { getState: vi.fn(), setAutoConnect: vi.fn() },
  };
}

describe("native SSH service discovery", () => {
  it("discovers the registry by its service shape, independent of chunk and export names", async () => {
    const native = services();
    const load = vi.fn().mockResolvedValue({ renamedExport: native, sameRegistry: native });
    expect(await loadCodexSshServices(owner("/assets/relocated-123.js"), load)).toBe(native);
    expect(load).toHaveBeenCalledWith("app://-/assets/relocated-123.js");
  });

  it("prioritizes the shared module without importing unrelated preloads", async () => {
    const native = services();
    const load = vi.fn().mockResolvedValue({ arbitraryName: native });
    await loadCodexSshServices(owner("/assets/other.js", "/assets/app-shared-newhash.js"), load);
    expect(load.mock.calls).toEqual([["app://-/assets/app-shared-newhash.js"]]);
  });

  it("supports callable RPC stubs and rejects incomplete registries", async () => {
    const native = {
      sshConnections: Object.assign(() => {}, { refresh: vi.fn(), save: vi.fn() }),
      remoteConnections: Object.assign(() => {}, { getState: vi.fn(), setAutoConnect: vi.fn() }),
    };
    const load = vi
      .fn()
      .mockResolvedValueOnce({ incomplete: { sshConnections: {} } })
      .mockResolvedValueOnce({ native });
    expect(await loadCodexSshServices(owner("/a.js", "/b.js"), load)).toBe(native);
  });

  it("does not import foreign URLs, non-module assets or URLs with query/hash values", async () => {
    const load = vi.fn();
    expect(
      await loadCodexSshServices(
        owner(
          "app://other/assets/a.js",
          "https://example.com/a.js",
          "/a.css",
          "/a.js?x=1",
          "/a.js#x",
        ),
        load,
      ),
    ).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("allows legacy windows without a registry and skips unavailable modules", async () => {
    const load = vi.fn().mockRejectedValue(new Error("module unavailable"));
    expect(await loadCodexSshServices(owner("/a.js"), load)).toBeNull();
    expect(await loadCodexSshServices({} as Window, load)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an owning module exposes different registries", async () => {
    const load = vi.fn().mockResolvedValue({ first: services(), second: services() });
    await expect(loadCodexSshServices(owner("/a.js"), load)).rejects.toThrow("unavailable");
  });
});
