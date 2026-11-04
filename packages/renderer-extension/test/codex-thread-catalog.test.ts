import { describe, expect, it, vi } from "vitest";
import { invalidateThreadCatalog } from "../src/codex-thread-catalog.js";

function owner(...urls: string[]): Window {
  return {
    location: { href: "app://-/index.html" },
    document: {
      querySelectorAll: () => urls.map((url) => ({ getAttribute: () => url })),
    },
  } as unknown as Window;
}

describe("native Thread catalog invalidation", () => {
  it("calls the discovered local service once despite duplicate exports", async () => {
    const invalidateSource = vi.fn().mockResolvedValue(undefined);
    const services = { localThreadCatalog: { invalidateSource } };
    const load = vi.fn().mockResolvedValue({ native: services, alias: services });

    await invalidateThreadCatalog(owner("/assets/relocated.js", "/other.js"), load);

    expect(invalidateSource).toHaveBeenCalledExactlyOnceWith("local");
  });

  it("supports a callable service but does not accept synthesized transport properties", async () => {
    const invalidateSource = vi.fn().mockResolvedValue(undefined);
    const transport = new Proxy({}, { get: () => ({ invalidateSource }) });
    const inherited = Object.create({ localThreadCatalog: { invalidateSource } });
    const load = vi.fn().mockResolvedValue({ transport, inherited });
    await invalidateThreadCatalog(owner("/loaded.js"), load);
    expect(invalidateSource).not.toHaveBeenCalled();

    const service = Object.assign(() => {}, { invalidateSource });
    load.mockResolvedValue({ services: { localThreadCatalog: service } });
    await invalidateThreadCatalog(owner("/loaded.js"), load);
    expect(invalidateSource).toHaveBeenCalledExactlyOnceWith("local");
  });

  it("reads AppServices from the executed Rspack cache without invoking module factories", async () => {
    const invalidateSource = vi.fn().mockResolvedValue(undefined);
    const services = { localThreadCatalog: { invalidateSource } };
    const unloadedFactory = vi.fn();
    const runtime = Object.assign(vi.fn(), {
      c: {
        unrelated: { exports: {} },
        unavailable: {
          get exports() {
            throw new Error("cross-origin export");
          },
        },
        loaded: {
          exports: {
            get appServices() {
              return services;
            },
          },
        },
      },
      m: { unloaded: unloadedFactory },
    });
    const load = vi.fn().mockResolvedValue({ __webpack_require__: runtime });

    await invalidateThreadCatalog(owner("/assets/arbitrary-runtime.js"), load);

    expect(invalidateSource).toHaveBeenCalledExactlyOnceWith("local");
    expect(runtime).not.toHaveBeenCalled();
    expect(unloadedFactory).not.toHaveBeenCalled();
  });

  it("ignores conflicting AppServices registries in the executed module cache", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const runtime = Object.assign(vi.fn(), {
      c: {
        a: { exports: { appServices: { localThreadCatalog: { invalidateSource: first } } } },
        b: { exports: { appServices: { localThreadCatalog: { invalidateSource: second } } } },
      },
    });
    const load = vi.fn().mockResolvedValue({ __webpack_require__: runtime });

    await expect(invalidateThreadCatalog(owner("/runtime.js"), load)).resolves.toBeUndefined();

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(runtime).not.toHaveBeenCalled();
  });

  it("ignores an unavailable or incomplete registry", async () => {
    const load = vi.fn().mockResolvedValue({ services: { localThreadCatalog: {} } });
    await expect(invalidateThreadCatalog({} as Window, load)).resolves.toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    await expect(invalidateThreadCatalog(owner("/loaded.js"), load)).resolves.toBeUndefined();
  });

  it("does not select a service when discovery is ambiguous", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const load = vi.fn().mockResolvedValue({
      first: { localThreadCatalog: { invalidateSource: first } },
      second: { localThreadCatalog: { invalidateSource: second } },
    });
    await expect(invalidateThreadCatalog(owner("/loaded.js"), load)).resolves.toBeUndefined();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("ignores discovery failures without another attempt", async () => {
    const load = vi.fn().mockRejectedValue(new Error("module unavailable"));
    await expect(invalidateThreadCatalog(owner("/loaded.js"), load)).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("ignores a native rejection without repeating invalidation", async () => {
    const invalidateSource = vi.fn().mockRejectedValue(new Error("source is not active"));
    const load = vi
      .fn()
      .mockResolvedValue({ services: { localThreadCatalog: { invalidateSource } } });
    await expect(invalidateThreadCatalog(owner("/loaded.js"), load)).resolves.toBeUndefined();
    expect(invalidateSource).toHaveBeenCalledExactlyOnceWith("local");
  });
});
