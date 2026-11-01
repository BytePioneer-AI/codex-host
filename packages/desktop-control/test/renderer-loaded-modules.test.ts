import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installRendererLoadedModules } from "../src/renderer-loaded-modules.js";

type Catalog = { owner: string; complete: boolean; urls: string[]; documentUrl: string };
function fixture(modules = ["app://-/assets/deep.js"]) {
  const listeners = new Map<string, Set<(params: unknown) => void>>();
  const pages = new Map<
    string,
    { location: { href: string }; __codexhostLoadedModulesV1?: Catalog }
  >();
  const page = (uniqueId: string) => {
    let value = pages.get(uniqueId);
    if (!value) {
      value = { location: { href: "app://-/index.html" } };
      pages.set(uniqueId, value);
    }
    return value;
  };
  const emit = (method: string, params: unknown) => {
    for (const listener of listeners.get(method) ?? []) listener(params);
  };
  const context = (id = 1, uniqueId = "main", isDefault = true) => {
    page(uniqueId);
    emit("Runtime.executionContextCreated", { context: { id, uniqueId, auxData: { isDefault } } });
  };
  const parsed = (url: string, extra = {}) =>
    emit("Debugger.scriptParsed", {
      url,
      executionContextId: 1,
      isModule: true,
      hasSourceURL: false,
      ...extra,
    });
  const client = {
    on(method: string, listener: (params: unknown) => void) {
      const set = listeners.get(method) ?? new Set();
      set.add(listener);
      listeners.set(method, set);
      return () => {
        set.delete(listener);
      };
    },
    command: vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      if (method === "Runtime.enable") {
        context();
        context(2, "isolated", false);
      }
      if (method === "Debugger.enable") for (const url of modules) parsed(url);
      if (method === "Runtime.evaluate")
        runInNewContext(String(params?.expression), page(String(params?.uniqueContextId)));
      return {};
    }),
  };
  return { client, emit, context, parsed, pages, page, listeners };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Controller loaded Renderer module catalog", () => {
  it("subscribes before replay and publishes deep ES modules before Renderer service discovery", async () => {
    const f = fixture();
    const dispose = await installRendererLoadedModules(f.client);
    expect(f.client.command.mock.calls.map(([method]) => method)).toEqual([
      "Runtime.enable",
      "Debugger.enable",
      "Runtime.evaluate",
    ]);
    expect(f.page("main").__codexhostLoadedModulesV1).toMatchObject({
      documentUrl: "app://-/index.html",
      complete: true,
      urls: ["app://-/assets/deep.js"],
    });
    expect(f.page("isolated").__codexhostLoadedModulesV1).toBeUndefined();
    expect(f.client.command.mock.calls.some(([method]) => method === "Debugger.pause")).toBe(false);
    dispose();
    expect(f.page("main").__codexhostLoadedModulesV1?.complete).toBe(false);
    expect([...f.listeners.values()].every((set) => set.size === 0)).toBe(true);
  });

  it("tracks subsequent lazy loads, deduplicates URLs, and ignores classic or sourceURL-spoofed scripts", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const dispose = await installRendererLoadedModules(f.client);
    f.parsed("app://-/assets/lazy-now-loaded.js");
    f.parsed("app://-/assets/lazy-now-loaded.js");
    f.parsed("app://-/assets/classic.js", { isModule: false });
    f.parsed("app://-/assets/spoof.js", { hasSourceURL: true });
    f.parsed("app://-/assets/isolated.js", { executionContextId: 2 });
    await vi.advanceTimersByTimeAsync(10);
    expect(f.page("main").__codexhostLoadedModulesV1?.urls).toEqual([
      "app://-/assets/deep.js",
      "app://-/assets/lazy-now-loaded.js",
    ]);
    expect(
      f.client.command.mock.calls.filter(([method]) => method === "Runtime.evaluate"),
    ).toHaveLength(2);
    dispose();
  });

  it("keeps iframe catalogs separate and never publishes a destroyed context's pending modules", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const dispose = await installRendererLoadedModules(f.client);
    f.context(3, "iframe");
    f.parsed("app://-/assets/frame.js", { executionContextId: 3 });
    await vi.advanceTimersByTimeAsync(10);
    expect(f.page("iframe").__codexhostLoadedModulesV1?.urls).toEqual(["app://-/assets/frame.js"]);
    f.parsed("app://-/assets/pending.js", { executionContextId: 3 });
    f.emit("Runtime.executionContextDestroyed", { executionContextId: 3 });
    await vi.advanceTimersByTimeAsync(10);
    expect(f.page("iframe").__codexhostLoadedModulesV1?.urls).not.toContain(
      "app://-/assets/pending.js",
    );
    dispose();
  });

  it("starts a fresh allowlist after reload even when numeric context IDs are reused", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const dispose = await installRendererLoadedModules(f.client);
    f.parsed("app://-/old-pending.js");
    f.emit("Runtime.executionContextsCleared", {});
    f.context(1, "reloaded");
    f.parsed("app://-/new.js");
    await vi.advanceTimersByTimeAsync(10);
    expect(f.page("reloaded").__codexhostLoadedModulesV1?.urls).toEqual(["app://-/new.js"]);
    expect(f.client.command.mock.calls.at(-1)?.[1]?.uniqueContextId).toBe("reloaded");
    dispose();
  });

  it("does not invalidate a replacement Controller's catalog when the old connection closes", async () => {
    const f = fixture();
    const first = await installRendererLoadedModules(f.client);
    const second = await installRendererLoadedModules(f.client);
    const owner = f.page("main").__codexhostLoadedModulesV1?.owner;
    first();
    expect(f.page("main").__codexhostLoadedModulesV1).toMatchObject({ owner, complete: true });
    second();
    expect(f.page("main").__codexhostLoadedModulesV1?.complete).toBe(false);
  });

  it("fails closed instead of publishing a silently truncated uniqueness search", async () => {
    const f = fixture(Array.from({ length: 4097 }, (_, n) => `app://-/assets/chunk-${n}.js`));
    const dispose = await installRendererLoadedModules(f.client);
    expect(f.page("main").__codexhostLoadedModulesV1?.complete).toBe(false);
    expect(f.page("main").__codexhostLoadedModulesV1?.urls).toHaveLength(4096);
    dispose();
  });

  it("releases subscriptions and invalidates the catalog if Debugger initialization fails", async () => {
    const f = fixture();
    const original = f.client.command.getMockImplementation();
    if (!original) throw Error("Missing CDP implementation");
    f.client.command.mockImplementation(async (method, params) => {
      if (method === "Debugger.enable") throw Error("Debugger unavailable");
      return original(method, params);
    });
    await expect(installRendererLoadedModules(f.client)).rejects.toThrow("Debugger unavailable");
    expect([...f.listeners.values()].every((set) => set.size === 0)).toBe(true);
    expect(f.page("main").__codexhostLoadedModulesV1?.complete).toBe(false);
  });

  it("skips a child-frame context destroyed while its publication was in flight and still publishes the rest", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fixture();
    const original = f.client.command.getMockImplementation();
    if (!original) throw Error("Missing CDP implementation");
    f.client.command.mockImplementation(async (method, params) => {
      if (method === "Runtime.evaluate" && params?.uniqueContextId === "sandbox") {
        // Chromium delivers executionContextDestroyed before the failed response.
        f.emit("Runtime.executionContextDestroyed", {
          executionContextId: 3,
          executionContextUniqueId: "sandbox",
        });
        throw Error("uniqueContextId not found");
      }
      return original(method, params);
    });
    const dispose = await installRendererLoadedModules(f.client);
    f.context(3, "sandbox");
    f.parsed("app://-/assets/lazy.js");
    await vi.advanceTimersByTimeAsync(10);
    expect(errors).not.toHaveBeenCalled();
    expect(f.page("main").__codexhostLoadedModulesV1?.urls).toEqual([
      "app://-/assets/deep.js",
      "app://-/assets/lazy.js",
    ]);
    f.parsed("app://-/assets/frame.js", { executionContextId: 3 });
    await vi.advanceTimersByTimeAsync(10);
    expect(
      f.client.command.mock.calls.filter(
        ([method, params]) =>
          method === "Runtime.evaluate" && params?.uniqueContextId === "sandbox",
      ),
    ).toHaveLength(1);
    dispose();
  });

  it("forgets a context the Renderer reports as gone even before executionContextDestroyed arrives", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fixture();
    const original = f.client.command.getMockImplementation();
    if (!original) throw Error("Missing CDP implementation");
    f.client.command.mockImplementation(async (method, params) => {
      if (method === "Runtime.evaluate" && params?.uniqueContextId === "gone")
        throw Error("Cannot find context with specified id");
      return original(method, params);
    });
    const dispose = await installRendererLoadedModules(f.client);
    f.context(4, "gone");
    await vi.advanceTimersByTimeAsync(10);
    f.parsed("app://-/assets/late.js", { executionContextId: 4 });
    await vi.advanceTimersByTimeAsync(10);
    expect(errors).not.toHaveBeenCalled();
    expect(
      f.client.command.mock.calls.filter(([, params]) => params?.uniqueContextId === "gone"),
    ).toHaveLength(1);
    // A replacement frame document gets its own context and is published normally.
    f.context(5, "replacement");
    f.parsed("app://-/assets/frame.js", { executionContextId: 5 });
    await vi.advanceTimersByTimeAsync(10);
    expect(f.page("replacement").__codexhostLoadedModulesV1?.urls).toEqual([
      "app://-/assets/frame.js",
    ]);
    dispose();
  });

  it("removes a destroyed context by its unique ID when the numeric ID is absent", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const dispose = await installRendererLoadedModules(f.client);
    f.context(6, "unique-only");
    f.emit("Runtime.executionContextDestroyed", { executionContextUniqueId: "unique-only" });
    await vi.advanceTimersByTimeAsync(10);
    expect(
      f.client.command.mock.calls.some(([, params]) => params?.uniqueContextId === "unique-only"),
    ).toBe(false);
    dispose();
  });

  it("still reports genuine publication failures after publishing the other contexts", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fixture();
    const original = f.client.command.getMockImplementation();
    if (!original) throw Error("Missing CDP implementation");
    f.client.command.mockImplementation(async (method, params) => {
      if (method === "Runtime.evaluate" && params?.uniqueContextId === "broken")
        return { exceptionDetails: { text: "boom" } };
      return original(method, params);
    });
    const dispose = await installRendererLoadedModules(f.client);
    f.context(7, "broken");
    f.parsed("app://-/assets/after-broken.js");
    await vi.advanceTimersByTimeAsync(10);
    expect(f.page("main").__codexhostLoadedModulesV1?.urls).toContain(
      "app://-/assets/after-broken.js",
    );
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[1])).toContain("publication failed");
    dispose();
  });
});
