import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readCodexLocaleSettings, setCodexLocaleOverride } from "../src/codex-locale-adapter.js";
import type * as NativeServices from "../src/codex-native-services.js";

const { exportsForModule, discover, importModule } = vi.hoisted(() => ({
  exportsForModule: { current: {} as Record<string, unknown> },
  discover: vi.fn(),
  importModule: vi.fn<() => Promise<Record<string, unknown>>>(),
}));
vi.mock("../src/codex-native-services.js", async (importOriginal) => {
  const original = await importOriginal<typeof NativeServices>();
  return {
    loadCodexNativeServices: (...args: Parameters<typeof original.loadCodexNativeServices>) => {
      discover();
      return original.loadCodexNativeServices(args[0], args[1], importModule);
    },
  };
});

function fixture(response: unknown = { effective: "zh-CN", configured: undefined }) {
  const events = new EventTarget();
  const ownerWindow = {
    document: {
      querySelectorAll: () => [{ getAttribute: () => "/assets/app-shared-fixture.js" }],
    },
    location: { href: "app://-/index.html" },
    navigator: { languages: ["en-US"], language: "en-US" },
    crypto: { randomUUID: () => crypto.randomUUID() },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    electronBridge: { sendMessageFromView: vi.fn() },
  } as unknown as Window & { electronBridge: { sendMessageFromView: ReturnType<typeof vi.fn> } };
  const native = {
    // Desktop service stubs are callable proxies, not records of named methods.
    settings: Object.assign(() => {}, {
      read: vi.fn().mockResolvedValue(response),
      write: vi.fn().mockResolvedValue(undefined),
    }),
    appInfo: Object.assign(() => {}, {
      getLocaleInfo: vi.fn().mockResolvedValue({ ideLocale: "de-DE", systemLocale: "fr-FR" }),
    }),
  };
  // The transport root manufactures arbitrary callable paths. It is not the service registry.
  const transport: unknown = new Proxy(() => {}, { get: () => transport });
  exportsForModule.current = { registry: native, alias: native, transport };
  return { native, ownerWindow };
}

beforeEach(() => {
  discover.mockClear();
  importModule.mockReset().mockImplementation(async () => exportsForModule.current);
});
afterEach(() => vi.useRealTimers());

describe("Desktop native locale settings", () => {
  it("selects the owning service registry, not the callable transport root, and reads effective", async () => {
    const { native, ownerWindow } = fixture({ effective: "zh-cn", configured: "en-US" });
    expect(await readCodexLocaleSettings({ ownerWindow, timeoutMs: 20 })).toMatchObject({
      status: "ready",
      mode: "explicit",
      localeOverride: "zh-CN",
      preferredLocale: "zh-CN",
      source: "override",
    });
    expect(native.settings.read).toHaveBeenCalledExactlyOnceWith("localeOverride");
    expect(ownerWindow.electronBridge.sendMessageFromView).not.toHaveBeenCalled();
  });

  it("uses null effective as automatic even with no configured value", async () => {
    const { ownerWindow } = fixture({ effective: null, configured: undefined });
    expect(await readCodexLocaleSettings({ ownerWindow, timeoutMs: 20 })).toMatchObject({
      status: "ready",
      mode: "automatic",
      localeOverride: null,
      preferredLocale: "de-DE",
      source: "ide",
    });
  });

  it.each(["zh-CN", "en-US", null] as const)(
    "writes the bounded native override %s",
    async (value) => {
      const { native, ownerWindow } = fixture();
      await setCodexLocaleOverride(value, { ownerWindow, timeoutMs: 20 });
      expect(native.settings.write).toHaveBeenCalledExactlyOnceWith("localeOverride", value);
      expect(ownerWindow.electronBridge.sendMessageFromView).not.toHaveBeenCalled();
    },
  );

  it("does not require the legacy bridge when native services are present", async () => {
    const { native, ownerWindow } = fixture();
    Reflect.deleteProperty(ownerWindow, "electronBridge");
    expect(await readCodexLocaleSettings({ ownerWindow, timeoutMs: 20 })).toMatchObject({
      mode: "explicit",
      preferredLocale: "zh-CN",
    });
    await setCodexLocaleOverride(null, { ownerWindow, timeoutMs: 20 });
    expect(native.settings.write).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    {},
    { configured: "zh-CN" },
    { effective: undefined },
    { effective: "bad_locale" },
  ])(
    "rejects malformed native reads rather than inferring automatic mode: %s",
    async (response) => {
      const { ownerWindow } = fixture(response);
      expect(await readCodexLocaleSettings({ ownerWindow, timeoutMs: 20 })).toMatchObject({
        status: "fallback",
        mode: "unavailable",
        source: "navigator",
      });
      expect(ownerWindow.electronBridge.sendMessageFromView).not.toHaveBeenCalled();
    },
  );

  it("fails closed for two distinct owning registries", async () => {
    const { native, ownerWindow } = fixture();
    const second = { settings: Object.assign(() => {}, { read: vi.fn(), write: vi.fn() }) };
    exportsForModule.current.second = second;
    await expect(setCodexLocaleOverride(null, { ownerWindow, timeoutMs: 20 })).rejects.toThrow(
      "Codex native services are unavailable",
    );
    expect(native.settings.write).not.toHaveBeenCalled();
    expect(second.settings.write).not.toHaveBeenCalled();
    expect(ownerWindow.electronBridge.sendMessageFromView).not.toHaveBeenCalled();
  });

  it("does not retry a failed native read through the legacy endpoint", async () => {
    const { native, ownerWindow } = fixture();
    native.settings.read.mockRejectedValue(new Error("read denied"));
    expect(await readCodexLocaleSettings({ ownerWindow })).toMatchObject({
      status: "fallback",
      mode: "unavailable",
      source: "navigator",
    });
    expect(ownerWindow.electronBridge.sendMessageFromView).not.toHaveBeenCalled();
  });

  it.each(["read", "write"] as const)(
    "disposes the native %s request on completion",
    async (operation) => {
      const { native, ownerWindow } = fixture();
      const dispose = vi.fn();
      native.settings[operation].mockReturnValue(
        Object.assign(Promise.resolve(operation === "read" ? { effective: "zh-CN" } : undefined), {
          [Symbol.dispose]: dispose,
        }),
      );
      if (operation === "read") await readCodexLocaleSettings({ ownerWindow });
      else await setCodexLocaleOverride(null, { ownerWindow });
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it.each(["abort", "timeout"])("ignores and disposes native reads after %s", async (boundary) => {
    vi.useFakeTimers();
    const { native, ownerWindow } = fixture();
    let complete!: (value: unknown) => void;
    const dispose = vi.fn();
    native.settings.read.mockReturnValue(
      Object.assign(
        new Promise((resolve) => {
          complete = resolve;
        }),
        { [Symbol.dispose]: dispose },
      ),
    );
    const controller = new AbortController();
    const pending = readCodexLocaleSettings({
      ownerWindow,
      signal: controller.signal,
      timeoutMs: 20,
    });
    const assertion =
      boundary === "abort"
        ? expect(pending).rejects.toMatchObject({ name: "AbortError" })
        : expect(pending).resolves.toMatchObject({ mode: "unavailable", source: "navigator" });
    await vi.advanceTimersByTimeAsync(0);
    expect(native.settings.read).toHaveBeenCalledOnce();
    if (boundary === "abort") controller.abort();
    else await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(dispose).toHaveBeenCalledOnce();
    complete({ effective: "zh-CN" });
    await vi.advanceTimersByTimeAsync(0);
    expect(dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(ownerWindow.electronBridge.sendMessageFromView).not.toHaveBeenCalled();
  });

  it("rejects a native disposal failure rather than leaving the write pending", async () => {
    const { native, ownerWindow } = fixture();
    native.settings.write.mockReturnValue(
      Object.assign(Promise.resolve(), {
        [Symbol.dispose]() {
          throw new Error("dispose failed");
        },
      }),
    );
    await expect(setCodexLocaleOverride(null, { ownerWindow })).rejects.toThrow("dispose failed");
    expect(ownerWindow.electronBridge.sendMessageFromView).not.toHaveBeenCalled();
  });

  it("does not retry a failed native write through the legacy endpoint", async () => {
    const { native, ownerWindow } = fixture();
    native.settings.write.mockRejectedValue(new Error("write denied"));
    await expect(setCodexLocaleOverride(null, { ownerWindow })).rejects.toThrow("write denied");
    expect(ownerWindow.electronBridge.sendMessageFromView).not.toHaveBeenCalled();
  });

  it.each(["abort", "timeout"])(
    "does not start a late-discovered write after %s",
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
      const pending = setCodexLocaleOverride(null, {
        ownerWindow,
        signal: controller.signal,
        timeoutMs: 20,
      });
      const assertion = expect(pending).rejects.toThrow(
        boundary === "abort" ? "aborted" : "timed out",
      );
      if (boundary === "abort") controller.abort();
      else await vi.advanceTimersByTimeAsync(20);
      await assertion;
      ready(exportsForModule.current);
      await vi.advanceTimersByTimeAsync(0);
      expect(native.settings.write).not.toHaveBeenCalled();
      expect(ownerWindow.electronBridge.sendMessageFromView).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["abort", "timeout"])("ignores a native write completion after %s", async (boundary) => {
    vi.useFakeTimers();
    const { native, ownerWindow } = fixture();
    let complete!: () => void;
    const dispose = vi.fn();
    native.settings.write.mockReturnValue(
      Object.assign(
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
        { [Symbol.dispose]: dispose },
      ),
    );
    const controller = new AbortController();
    const pending = setCodexLocaleOverride(null, {
      ownerWindow,
      signal: controller.signal,
      timeoutMs: 20,
    });
    const assertion = expect(pending).rejects.toThrow(
      boundary === "abort" ? "aborted" : "timed out",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(native.settings.write).toHaveBeenCalledOnce();
    if (boundary === "abort") controller.abort();
    else await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(dispose).toHaveBeenCalledOnce();
    complete();
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(ownerWindow.electronBridge.sendMessageFromView).not.toHaveBeenCalled();
  });

  it("does not discover services for an already-aborted write", async () => {
    const { native, ownerWindow } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      setCodexLocaleOverride(null, { ownerWindow, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(discover).not.toHaveBeenCalled();
    expect(native.settings.write).not.toHaveBeenCalled();
  });
});
