import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readCodexLocaleSettings, setCodexLocaleOverride } from "../src/codex-locale-adapter.js";
import type * as NativeServices from "../src/codex-native-services.js";

const { exportsForModule, importModule } = vi.hoisted(() => ({
  exportsForModule: { current: {} as Record<string, unknown> },
  importModule: vi.fn<() => Promise<Record<string, unknown>>>(),
}));
vi.mock("../src/codex-native-services.js", async (importOriginal) => {
  const original = await importOriginal<typeof NativeServices>();
  return {
    loadCodexNativeServices: (...args: Parameters<typeof original.loadCodexNativeServices>) =>
      original.loadCodexNativeServices(args[0], args[1], importModule),
  };
});

function fixture(response: unknown = { effective: "zh-CN", configured: undefined }) {
  const ownerWindow = {
    document: { querySelectorAll: () => [{ getAttribute: () => "/assets/app-shared-fixture.js" }] },
    location: { href: "app://-/index.html" },
    navigator: { languages: ["en-US"], language: "en-US" },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  } as unknown as Window;
  const native = {
    // Native service stubs are callable; the registry owns their named properties.
    settings: Object.assign(() => {}, {
      read: vi.fn().mockResolvedValue(response),
      write: vi.fn().mockResolvedValue(undefined),
    }),
    appInfo: Object.assign(() => {}, {
      getLocaleInfo: vi.fn().mockResolvedValue({ ideLocale: "de-DE", systemLocale: "fr-FR" }),
    }),
  };
  const transport: unknown = new Proxy(() => {}, { get: () => transport });
  exportsForModule.current = { registry: native, alias: native, transport };
  return { native, ownerWindow };
}

beforeEach(() => {
  importModule.mockReset().mockImplementation(async () => exportsForModule.current);
});
afterEach(() => vi.useRealTimers());

describe("Codex native locale adapter", () => {
  it("selects the owning registry rather than transport paths and reads effective, not configured", async () => {
    const { native, ownerWindow } = fixture({ effective: "zh-cn", configured: "en-US" });
    expect(await readCodexLocaleSettings({ ownerWindow })).toEqual({
      status: "ready",
      mode: "explicit",
      localeOverride: "zh-CN",
      preferredLocale: "zh-CN",
      ideLocale: "de-DE",
      systemLocale: "fr-FR",
      source: "override",
    });
    expect(native.settings.read).toHaveBeenCalledExactlyOnceWith("localeOverride");
    expect(native.appInfo.getLocaleInfo).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    [{ ideLocale: "zh-cn", systemLocale: "de-DE" }, ["en-US"], "zh-CN", "ide"],
    [{ ideLocale: null, systemLocale: "de-de" }, ["en-US"], "de-DE", "system"],
    [{}, ["bad_locale", "zh-TW"], "zh-TW", "navigator"],
    [{}, [], "en-US", "default"],
  ])(
    "resolves automatic locale in native priority order: %s",
    async (info, languages, locale, source) => {
      const { native, ownerWindow } = fixture({ effective: null, configured: undefined });
      native.appInfo.getLocaleInfo.mockResolvedValue(info);
      Object.defineProperty(ownerWindow, "navigator", { value: { languages, language: "" } });
      expect(await readCodexLocaleSettings({ ownerWindow })).toMatchObject({
        status: "ready",
        mode: "automatic",
        localeOverride: null,
        preferredLocale: locale,
        source,
      });
    },
  );

  it.each([
    null,
    {},
    { configured: "zh-CN" },
    { effective: undefined },
    { effective: "bad_locale" },
  ])(
    "keeps malformed overrides unavailable, even with native locale info: %s",
    async (response) => {
      const { ownerWindow } = fixture(response);
      expect(await readCodexLocaleSettings({ ownerWindow })).toMatchObject({
        status: "fallback",
        mode: "unavailable",
        localeOverride: undefined,
        ideLocale: "de-DE",
        systemLocale: "fr-FR",
        source: "navigator",
        preferredLocale: "en-US",
      });
    },
  );

  it.each([null, [], { ideLocale: 42 }, { systemLocale: "bad_locale" }])(
    "rejects malformed native locale info: %s",
    async (info) => {
      const { native, ownerWindow } = fixture({ effective: null });
      native.appInfo.getLocaleInfo.mockResolvedValue(info);
      expect(await readCodexLocaleSettings({ ownerWindow })).toMatchObject({
        mode: "automatic",
        ideLocale: undefined,
        systemLocale: undefined,
        source: "navigator",
      });
    },
  );

  it("keeps navigator degradation but rejects writes when native services are absent", async () => {
    const { ownerWindow } = fixture();
    exportsForModule.current = {};
    expect(await readCodexLocaleSettings({ ownerWindow })).toMatchObject({
      status: "fallback",
      mode: "unavailable",
      source: "navigator",
    });
    await expect(setCodexLocaleOverride(null, { ownerWindow })).rejects.toThrow(
      "services are unavailable",
    );
  });

  it("discovers settings and appInfo independently", async () => {
    const { native, ownerWindow } = fixture({ effective: null });
    exportsForModule.current = { settingsOnly: { settings: native.settings } };
    expect(await readCodexLocaleSettings({ ownerWindow })).toMatchObject({
      mode: "automatic",
      source: "navigator",
    });
    exportsForModule.current = { infoOnly: { appInfo: native.appInfo } };
    expect(await readCodexLocaleSettings({ ownerWindow })).toMatchObject({
      mode: "unavailable",
      source: "navigator",
      ideLocale: "de-DE",
    });
  });

  it("fails closed for two distinct owning registries", async () => {
    const { native, ownerWindow } = fixture();
    const second = { settings: Object.assign(() => {}, { read: vi.fn(), write: vi.fn() }) };
    exportsForModule.current.second = second;
    await expect(setCodexLocaleOverride(null, { ownerWindow })).rejects.toThrow(
      "Codex native services are unavailable",
    );
    expect(native.settings.write).not.toHaveBeenCalled();
    expect(second.settings.write).not.toHaveBeenCalled();
  });

  it.each(["zh-CN", "en-US", null] as const)(
    "writes only the native bounded override %s",
    async (value) => {
      const { native, ownerWindow } = fixture();
      await setCodexLocaleOverride(value, { ownerWindow });
      expect(native.settings.write).toHaveBeenCalledExactlyOnceWith("localeOverride", value);
    },
  );

  it("handles native failures without losing override/locale distinction", async () => {
    const { native, ownerWindow } = fixture({ effective: null });
    native.appInfo.getLocaleInfo.mockRejectedValue(new Error("info denied"));
    expect(await readCodexLocaleSettings({ ownerWindow })).toMatchObject({
      mode: "automatic",
      source: "navigator",
    });
    native.settings.read.mockRejectedValue(new Error("read denied"));
    expect(await readCodexLocaleSettings({ ownerWindow })).toMatchObject({
      mode: "unavailable",
      source: "navigator",
    });
    native.settings.write.mockRejectedValue(new Error("write denied"));
    await expect(setCodexLocaleOverride(null, { ownerWindow })).rejects.toThrow("write denied");
  });

  it("validates bounded writes and timeout values before discovery", async () => {
    const { ownerWindow } = fixture();
    await expect(setCodexLocaleOverride("fr-FR" as "zh-CN", { ownerWindow })).rejects.toThrow(
      "Unsupported",
    );
    for (const timeoutMs of [0, -1, NaN, Infinity]) {
      await expect(readCodexLocaleSettings({ ownerWindow, timeoutMs })).rejects.toThrow(
        "timeout must be positive",
      );
      await expect(setCodexLocaleOverride(null, { ownerWindow, timeoutMs })).rejects.toThrow(
        "timeout must be positive",
      );
    }
    expect(importModule).not.toHaveBeenCalled();
  });

  it("does not discover services for already-aborted operations", async () => {
    const { ownerWindow } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      readCodexLocaleSettings({ ownerWindow, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      setCodexLocaleOverride(null, { ownerWindow, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(importModule).not.toHaveBeenCalled();
  });

  it.each(["abort", "timeout"])(
    "does not invoke services discovered after %s",
    async (boundary) => {
      vi.useFakeTimers();
      const { native, ownerWindow } = fixture();
      let ready!: (module: Record<string, unknown>) => void;
      importModule.mockReturnValue(
        new Promise((resolve) => {
          ready = resolve;
        }),
      );
      const controller = new AbortController();
      const options = { ownerWindow, signal: controller.signal, timeoutMs: 20 };
      const read = readCodexLocaleSettings(options);
      const write = setCodexLocaleOverride(null, options);
      const readAssertion =
        boundary === "abort"
          ? expect(read).rejects.toMatchObject({ name: "AbortError" })
          : expect(read).resolves.toMatchObject({ mode: "unavailable" });
      const writeAssertion = expect(write).rejects.toThrow(
        boundary === "abort" ? "aborted" : "timed out",
      );
      if (boundary === "abort") controller.abort();
      else await vi.advanceTimersByTimeAsync(20);
      await Promise.all([readAssertion, writeAssertion]);
      ready(exportsForModule.current);
      await vi.advanceTimersByTimeAsync(0);
      expect(native.settings.read).not.toHaveBeenCalled();
      expect(native.settings.write).not.toHaveBeenCalled();
      expect(native.appInfo.getLocaleInfo).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  describe.each(["override", "info", "write"] as const)("%s RPC lifetime", (operation) => {
    function setup() {
      const { native, ownerWindow } = fixture();
      const request =
        operation === "override"
          ? native.settings.read
          : operation === "info"
            ? native.appInfo.getLocaleInfo
            : native.settings.write;
      const run = (signal?: AbortSignal) => {
        const options = { ownerWindow, ...(signal ? { signal } : {}), timeoutMs: 20 };
        return operation === "write"
          ? setCodexLocaleOverride(null, options)
          : readCodexLocaleSettings(options);
      };
      return { request, run };
    }

    it.each([false, true])("releases completed requests (rejected=%s)", async (rejected) => {
      const { request, run } = setup();
      const dispose = vi.fn();
      request.mockReturnValue(
        Object.assign(
          rejected
            ? Promise.reject(new Error("native failed"))
            : Promise.resolve(
                operation === "override"
                  ? { effective: "zh-CN" }
                  : operation === "info"
                    ? {}
                    : undefined,
              ),
          { [Symbol.dispose]: dispose },
        ),
      );
      if (operation === "write" && rejected) await expect(run()).rejects.toThrow("native failed");
      else await run();
      expect(request).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
    });

    it.each(["abort", "timeout"])(
      "releases on %s and ignores late completion",
      async (boundary) => {
        vi.useFakeTimers();
        const { request, run } = setup();
        let complete!: (response: unknown) => void;
        const dispose = vi.fn();
        request.mockReturnValue(
          Object.assign(
            new Promise((resolve) => {
              complete = resolve;
            }),
            { [Symbol.dispose]: dispose },
          ),
        );
        const controller = new AbortController();
        const pending = run(controller.signal);
        const assertion =
          boundary === "abort"
            ? expect(pending).rejects.toMatchObject({ name: "AbortError" })
            : operation === "write"
              ? expect(pending).rejects.toThrow("timed out")
              : expect(pending).resolves.toMatchObject({
                  mode: operation === "info" ? "explicit" : "unavailable",
                });
        await vi.advanceTimersByTimeAsync(0);
        expect(request).toHaveBeenCalledOnce();
        if (boundary === "abort") controller.abort();
        else await vi.advanceTimersByTimeAsync(20);
        await assertion;
        expect(dispose).toHaveBeenCalledOnce();
        complete({ effective: "zh-CN", ideLocale: "zh-CN" });
        await vi.advanceTimersByTimeAsync(0);
        expect(dispose).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      },
    );
  });

  it("keeps discovery and invocation within one timeout budget", async () => {
    vi.useFakeTimers();
    const { native, ownerWindow } = fixture();
    importModule.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(exportsForModule.current), 15)),
    );
    const dispose = vi.fn();
    native.settings.write.mockReturnValue(
      Object.assign(new Promise(() => {}), { [Symbol.dispose]: dispose }),
    );
    const pending = setCodexLocaleOverride(null, { ownerWindow, timeoutMs: 20 });
    const assertion = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(15);
    expect(native.settings.write).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
    expect(dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects disposal failure rather than leaving a write pending", async () => {
    const { native, ownerWindow } = fixture();
    native.settings.write.mockReturnValue(
      Object.assign(Promise.resolve(), {
        [Symbol.dispose]() {
          throw new Error("dispose failed");
        },
      }),
    );
    await expect(setCodexLocaleOverride(null, { ownerWindow })).rejects.toThrow("dispose failed");
  });
});
