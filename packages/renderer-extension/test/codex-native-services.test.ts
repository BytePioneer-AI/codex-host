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
