import { afterEach, describe, expect, it, vi } from "vitest";
import { isNativeProjectThreadCreator } from "@codexhost/desktop-control/renderer-bindings";
import { loadCodexNativeServices } from "../src/codex-native-services.js";

async function creator({
  startWithoutFirstTurn: empty,
  onSettled: settled,
}: {
  startWithoutFirstTurn: boolean;
  onSettled: unknown;
}) {
  void empty;
  void settled;
  const errors = [
    "createThread config is not supported for delegated thread creation",
    "createThread serviceName is only supported for local Electron root threads outside worktrees",
  ];
  throw Error(errors.join("; "));
}
function fixture(catalog?: unknown) {
  const preloads = ["/assets/shared-anyhash.js", "/assets/runtime-anyhash.js"];
  const owner = {
    location: { href: "app://-/index.html" },
    document: { querySelectorAll: () => preloads.map((href) => ({ getAttribute: () => href })) },
    ...(catalog === undefined ? {} : { __codexhostLoadedModulesV1: catalog }),
  };
  const imported = vi.fn<(url: string) => Promise<Record<string, unknown>>>(async () => ({}));
  const load = () =>
    loadCodexNativeServices(owner as unknown as Window, isNativeProjectThreadCreator, imported);
  return { owner, preloads, imported, load };
}
const catalog = (urls: string[], extra = {}) => ({
  documentUrl: "app://-/index.html",
  complete: true,
  urls,
  ...extra,
});
afterEach(() => vi.restoreAllMocks());

/** Mirrors the bundled layout: the entry namespace exposes only the runtime, whose `.c` holds
 * instantiated modules and `.m` holds factories that must never run. */
function bundledRuntime(
  cache: Record<string, unknown>,
  factories: Record<string, () => unknown> = {},
) {
  const require = Object.assign(
    vi.fn(() => {
      throw new Error("The bundled runtime must not be called during discovery");
    }),
    { c: cache, m: factories },
  );
  return { namespace: { __webpack_require__: require } as Record<string, unknown>, require };
}
function compiledModule(bindings: Record<string, () => unknown>): { exports: object } {
  const exports = {};
  for (const [key, get] of Object.entries(bindings))
    Object.defineProperty(exports, key, { enumerable: true, get });
  return { exports };
}

describe("bundled runtime native service discovery", () => {
  const entry = "app://-/assets/entry.js";
  const container = "app://-/assets/container.js";

  function bundled(cache: Record<string, unknown>, factories?: Record<string, () => unknown>) {
    const f = fixture(catalog([container, entry]));
    const runtime = bundledRuntime(cache, factories);
    f.imported.mockImplementation(async (url) =>
      url === entry ? runtime.namespace : { __rspack_esm_id: "1", __webpack_modules__: {} },
    );
    return { ...f, runtime };
  }

  it("finds an instantiated export without calling the runtime or its factories", async () => {
    const factory = vi.fn();
    // Rspack emits `()=>binding`; defined literally so the source survives test transforms.
    const module = { exports: {} };
    const binding = creator;
    Object.defineProperty(module.exports, "Nw", {
      enumerable: true,
      get: new Function("binding", "return ()=>binding")(binding) as () => unknown,
    });
    const f = bundled({ owner: module, other: { exports: {} } }, { lazy: factory });
    expect(await f.load()).toBe(creator);
    expect(f.runtime.require).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not treat a registered factory as an available service", async () => {
    const factory = vi.fn(() => creator);
    const f = bundled({}, { lazy: factory });
    expect(await f.load()).toBeNull();
    expect(factory).not.toHaveBeenCalled();
    expect(f.runtime.require).not.toHaveBeenCalled();
  });

  it("deduplicates aliases but rejects two distinct instantiated services", async () => {
    const data = (value: unknown) => {
      const exports = {};
      Object.defineProperty(exports, "service", { enumerable: true, value });
      return { exports };
    };
    const duplicate = bundled({ a: data(creator), b: data(creator) });
    expect(await duplicate.load()).toBe(creator);
    const marked = (value: unknown): value is { marker: true } =>
      typeof value === "object" && value !== null && "marker" in value;
    const ambiguous = bundled({ a: data({ marker: true }), b: data({ marker: true }) });
    await expect(
      loadCodexNativeServices(ambiguous.owner as unknown as Window, marked, ambiguous.imported),
    ).rejects.toThrow("native services are unavailable");
  });

  it("does not run unknown accessors or enumerate CommonJS objects such as window", async () => {
    const lazy = vi.fn(() => creator);
    const exports = {};
    Object.defineProperty(exports, "lazy", { enumerable: true, get: lazy });
    const globalLike = {
      get service() {
        return lazy();
      },
    };
    const f = bundled({
      unknownGetter: { exports },
      commonJs: { exports: globalLike },
      failed: { error: new Error("boom"), exports: { service: creator } },
      deferred: { exports: Promise.resolve(creator) },
    });
    expect(await f.load()).toBeNull();
    expect(lazy).not.toHaveBeenCalled();
  });

  it("skips a binding still in its temporal dead zone", async () => {
    const throwing = new Function("return ()=>binding")() as () => unknown;
    const f = bundled({ early: compiledModule({ pending: throwing }) });
    expect(await f.load()).toBeNull();
  });

  it("scans past the URL catalog limit and fails closed beyond its own budget", async () => {
    const tail = {};
    Object.defineProperty(tail, "service", { enumerable: true, value: creator });
    const modules: Record<string, unknown> = {};
    for (let index = 0; index < 5_000; index++) modules[`m${index}`] = { exports: {} };
    modules.tail = { exports: tail };
    expect(await bundled(modules).load()).toBe(creator);
    const oversized: Record<string, unknown> = {};
    for (let index = 0; index <= 32_768; index++) oversized[`m${index}`] = {};
    await expect(bundled(oversized).load()).rejects.toThrow("native services are unavailable");
  });
});

describe("loaded native service discovery", () => {
  it("finds createThread in an already-loaded deep chunk absent from modulepreloads", async () => {
    const deep = "app://-/assets/deep-unrelated-name.js";
    const f = fixture(catalog(["app://-/assets/shared-anyhash.js", deep]));
    f.imported.mockImplementation(async (url) =>
      url === deep ? { arbitraryExport: creator, alias: creator } : {},
    );
    expect(await f.load()).toBe(creator);
    expect(f.imported.mock.calls.map(([url]) => url)).toEqual([
      "app://-/assets/shared-anyhash.js",
      deep,
    ]);
    expect(f.imported).not.toHaveBeenCalledWith("app://-/assets/runtime-anyhash.js");
  });

  it("preserves modulepreload discovery on older Desktop without a catalog", async () => {
    const f = fixture();
    f.imported.mockResolvedValue({ oldNativeExport: creator });
    expect(await f.load()).toBe(creator);
    expect(f.imported.mock.calls.map(([url]) => url)).toEqual(
      f.preloads.map((path) => `app://-${path}`),
    );
  });

  it("never imports an unloaded lazy module, even when a preload points to it", async () => {
    const f = fixture(catalog(["app://-/assets/loaded.js"]));
    f.preloads.push("/assets/unloaded-lazy.js");
    expect(await f.load()).toBeNull();
    expect(f.imported).toHaveBeenCalledExactlyOnceWith("app://-/assets/loaded.js");
  });

  it("filters foreign origins, non-JavaScript URLs, query/hash aliases and malformed URLs", async () => {
    const f = fixture(
      catalog([
        "app://-/assets/loaded.js",
        "https://example.com/lazy.js",
        "app://other/lazy.js",
        "app://-/assets/lazy.css",
        "app://-/assets/lazy.js?alternate",
        "app://-/assets/lazy.js#alias",
        "http://[",
      ]),
    );
    await f.load();
    expect(f.imported).toHaveBeenCalledExactlyOnceWith("app://-/assets/loaded.js");
  });

  it.each([
    catalog([], { complete: false }),
    catalog([], { documentUrl: "app://-/previous.html" }),
    catalog(["app://-/a.js"], { urls: [123] }),
    catalog(Array(4097).fill("app://-/a.js")),
    null,
  ])("fails closed for an incomplete, stale or invalid catalog", async (value) => {
    const f = fixture(value);
    await expect(f.load()).rejects.toThrow("loaded module catalog is unavailable");
    expect(f.imported).not.toHaveBeenCalled();
  });

  it("rejects distinct matching exports across chunks instead of selecting the first", async () => {
    const f = fixture(catalog(["app://-/a.js", "app://-/b.js"]));
    const other = { marker: true },
      first = { marker: true };
    f.imported.mockImplementation(async (url) => ({
      service: url.endsWith("a.js") ? first : other,
    }));
    await expect(
      loadCodexNativeServices(
        f.owner as unknown as Window,
        (value): value is typeof first =>
          typeof value === "object" && value !== null && "marker" in value,
        f.imported,
      ),
    ).rejects.toThrow("native services are unavailable");
    expect(f.imported).toHaveBeenCalledTimes(2);
  });

  it("tolerates native toString polyfills rejecting callable proxy exports", async () => {
    const f = fixture(catalog(["app://-/loaded.js"]));
    const proxy = function (value: unknown) {
      return value;
    };
    const original = Function.prototype.toString;
    vi.spyOn(Function.prototype, "toString").mockImplementation(function (this: unknown) {
      if (this === proxy)
        throw new TypeError("Function.prototype.toString requires that 'this' be a Function");
      return original.call(this);
    });
    f.imported.mockResolvedValue({ proxy, creator });
    expect(isNativeProjectThreadCreator(proxy)).toBe(false);
    expect(await f.load()).toBe(creator);
  });

  it("rejects a changing catalog instead of claiming uniqueness over an outdated snapshot", async () => {
    const f = fixture(catalog(["app://-/loaded.js"]));
    f.imported.mockImplementation(async () => {
      Reflect.set(
        f.owner,
        "__codexhostLoadedModulesV1",
        catalog(["app://-/loaded.js", "app://-/new.js"]),
      );
      return { creator };
    });
    await expect(f.load()).rejects.toThrow("catalog changed during discovery");
  });

  it("rereads the catalog after a lazy UI loads instead of caching a missing service", async () => {
    const f = fixture(catalog([]));
    expect(await f.load()).toBeNull();
    Reflect.set(f.owner, "__codexhostLoadedModulesV1", catalog(["app://-/now-loaded.js"]));
    f.imported.mockResolvedValue({ creator });
    expect(await f.load()).toBe(creator);
  });
});
