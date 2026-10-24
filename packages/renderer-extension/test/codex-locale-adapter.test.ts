import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readCodexLocaleSettings, setCodexLocaleOverride } from "../src/codex-locale-adapter.js";

const { loadNativeServices } = vi.hoisted(() => ({ loadNativeServices: vi.fn() }));
vi.mock("../src/codex-native-services.js", () => ({
  loadCodexNativeServices: loadNativeServices,
}));
beforeEach(() => {
  loadNativeServices.mockReset().mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

const handlerMissing = Symbol("handler not implemented");

interface FetchRequest {
  type: "fetch";
  requestId: string;
  url: string;
  body?: string;
}

function localeWindow(
  responses: Readonly<Record<string, unknown>>,
  languages: readonly string[] = ["en-US"],
  sentRequests: FetchRequest[] = [],
): Window {
  const events = new EventTarget();
  let requestOrdinal = 0;
  const ownerWindow = {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    clearTimeout: globalThis.clearTimeout,
    setTimeout: globalThis.setTimeout,
    crypto: {
      randomUUID: () => `00000000-0000-4000-8000-${String(++requestOrdinal).padStart(12, "0")}`,
    },
    navigator: { language: languages[0] ?? "", languages },
  } as unknown as Window & {
    electronBridge: { sendMessageFromView(message: unknown): Promise<void> };
  };
  ownerWindow.electronBridge = {
    async sendMessageFromView(message: unknown) {
      const request = message as FetchRequest;
      sentRequests.push(request);
      const body = responses[request.url];
      if (body === undefined) return;
      queueMicrotask(() => {
        events.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: "fetch-response",
              requestId: request.requestId,
              responseType: body === handlerMissing ? "error" : "success",
              status: body === handlerMissing ? 432 : 200,
              error: body === handlerMissing ? "handler not implemented" : undefined,
              bodyJsonString: JSON.stringify(body),
            },
          }),
        );
      });
    },
  };
  return ownerWindow;
}

describe("Codex locale adapter", () => {
  function nativeLocale(info: unknown) {
    const native = { appInfo: { getLocaleInfo: vi.fn().mockResolvedValue(info) } };
    loadNativeServices.mockImplementation(async (_owner, matches: (value: unknown) => boolean) =>
      matches(native) ? native : null,
    );
    return native;
  }

  it.each([
    [{ ideLocale: "zh-cn", systemLocale: "de-DE" }, "zh-CN", "ide"],
    [{ ideLocale: null, systemLocale: "de-de" }, "de-DE", "system"],
  ])("reads native locale when the legacy handler is missing: %s", async (info, locale, source) => {
    const native = nativeLocale(info);
    const sent: FetchRequest[] = [];
    const ownerWindow = localeWindow(
      {
        "vscode://codex/get-setting": { value: null },
        "vscode://codex/locale-info": handlerMissing,
      },
      ["en-US"],
      sent,
    );
    const result = await readCodexLocaleSettings({ ownerWindow });

    expect(result).toMatchObject({
      status: "ready",
      mode: "automatic",
      preferredLocale: locale,
      source,
    });
    expect(native.appInfo.getLocaleInfo).toHaveBeenCalledWith();
    expect(sent.map(({ url, body }) => ({ url, body }))).toEqual([
      { url: "vscode://codex/get-setting", body: JSON.stringify({ key: "localeOverride" }) },
    ]);
  });

  it("keeps an explicit override ahead of native IDE/system locales", async () => {
    nativeLocale({ ideLocale: "zh-CN", systemLocale: "de-DE" });
    const result = await readCodexLocaleSettings({
      ownerWindow: localeWindow({ "vscode://codex/get-setting": { value: "en-US" } }),
    });
    expect(result).toMatchObject({
      mode: "explicit",
      source: "override",
      preferredLocale: "en-US",
      ideLocale: "zh-CN",
      systemLocale: "de-DE",
    });
  });

  it.each([null, [], { ideLocale: 42 }, { systemLocale: "invalid_locale" }].map((info) => [info]))(
    "validates native locale responses before using them: %s",
    async (info) => {
      nativeLocale(info);
      const result = await readCodexLocaleSettings({
        ownerWindow: localeWindow({ "vscode://codex/get-setting": { value: null } }),
        timeoutMs: 10,
      });
      expect(result).toMatchObject({
        mode: "automatic",
        ideLocale: undefined,
        systemLocale: undefined,
        source: "navigator",
      });
    },
  );

  it("falls back to navigator if both the service and legacy locale handler are unavailable", async () => {
    const result = await readCodexLocaleSettings({
      ownerWindow: localeWindow({
        "vscode://codex/get-setting": { value: null },
        "vscode://codex/locale-info": handlerMissing,
      }),
    });
    expect(result).toMatchObject({ mode: "automatic", source: "navigator" });
  });

  it("does not treat an unavailable override as automatic even when native locale succeeds", async () => {
    nativeLocale({ ideLocale: "zh-CN", systemLocale: "de-DE" });
    const result = await readCodexLocaleSettings({ ownerWindow: localeWindow({}), timeoutMs: 10 });
    expect(result).toMatchObject({
      status: "fallback",
      mode: "unavailable",
      ideLocale: "zh-CN",
      systemLocale: "de-DE",
      source: "navigator",
    });
  });

  it.each(["abort", "timeout"])("does not call a service discovered after %s", async (boundary) => {
    vi.useFakeTimers();
    const native = nativeLocale({ ideLocale: "zh-CN" });
    let ready!: (value: typeof native) => void;
    loadNativeServices.mockReturnValue(
      new Promise((resolve) => {
        ready = resolve;
      }),
    );
    const controller = new AbortController();
    const ownerWindow = localeWindow({ "vscode://codex/get-setting": { value: null } });
    const pending = readCodexLocaleSettings({
      ownerWindow,
      signal: controller.signal,
      timeoutMs: 20,
    });
    if (boundary === "abort") {
      const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      await assertion;
    } else {
      await vi.advanceTimersByTimeAsync(20);
      expect(await pending).toMatchObject({ mode: "automatic", source: "navigator" });
    }
    ready(native);
    await Promise.resolve();
    await Promise.resolve();
    expect(native.appInfo.getLocaleInfo).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["abort", "timeout"])(
    "ignores native completion after %s and cleans up",
    async (boundary) => {
      vi.useFakeTimers();
      const native = nativeLocale(null);
      let complete!: (value: unknown) => void;
      native.appInfo.getLocaleInfo.mockReturnValue(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      const controller = new AbortController();
      const ownerWindow = localeWindow({ "vscode://codex/get-setting": { value: null } });
      const remove = vi.spyOn(ownerWindow, "removeEventListener");
      const pending = readCodexLocaleSettings({
        ownerWindow,
        signal: controller.signal,
        timeoutMs: 20,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(native.appInfo.getLocaleInfo).toHaveBeenCalledOnce();
      if (boundary === "abort") {
        const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
        controller.abort();
        await assertion;
      } else {
        await vi.advanceTimersByTimeAsync(20);
        expect(await pending).toMatchObject({ mode: "automatic", source: "navigator" });
      }
      complete({ ideLocale: "zh-CN" });
      await Promise.resolve();
      expect(remove.mock.calls.filter(([type]) => type === "message")).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("supports callable appInfo RPC stubs without any SSH services", async () => {
    const native = {
      appInfo: Object.assign(() => {}, {
        getLocaleInfo: vi.fn().mockResolvedValue({ systemLocale: "zh-CN" }),
      }),
    };
    loadNativeServices.mockImplementation(async (_owner, matches: (value: unknown) => boolean) =>
      matches(native) ? native : null,
    );
    expect(
      await readCodexLocaleSettings({
        ownerWindow: localeWindow({ "vscode://codex/get-setting": { value: null } }),
      }),
    ).toMatchObject({ source: "system", preferredLocale: "zh-CN" });
  });

  it.each([{}, { appInfo: null }, { appInfo: { getLocaleInfo: true } }])(
    "uses legacy locale info when the registry lacks the required service: %s",
    async (native) => {
      loadNativeServices.mockImplementation(async (_owner, matches: (value: unknown) => boolean) =>
        matches(native) ? native : null,
      );
      expect(
        await readCodexLocaleSettings({
          ownerWindow: localeWindow({
            "vscode://codex/get-setting": { value: null },
            "vscode://codex/locale-info": { systemLocale: "zh-CN" },
          }),
        }),
      ).toMatchObject({ source: "system", preferredLocale: "zh-CN" });
    },
  );

  it("keeps discovery and legacy fallback within one timeout budget", async () => {
    vi.useFakeTimers();
    loadNativeServices.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(null), 15)),
    );
    const ownerWindow = localeWindow({ "vscode://codex/get-setting": { value: "zh-CN" } });
    const pending = readCodexLocaleSettings({ ownerWindow, timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({
      mode: "explicit",
      preferredLocale: "zh-CN",
      source: "override",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles native rejection without retrying the removed legacy handler", async () => {
    const native = nativeLocale(null);
    native.appInfo.getLocaleInfo.mockRejectedValue(new Error("native read failed"));
    const sent: FetchRequest[] = [];
    const result = await readCodexLocaleSettings({
      ownerWindow: localeWindow({ "vscode://codex/get-setting": { value: null } }, ["en-US"], sent),
      timeoutMs: 20,
    });
    expect(result).toMatchObject({ mode: "automatic", source: "navigator" });
    expect(sent).toHaveLength(1);
  });

  it("does not discover or call native services for an already-aborted read", async () => {
    const native = nativeLocale({ ideLocale: "zh-CN" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      readCodexLocaleSettings({ ownerWindow: localeWindow({}), signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(loadNativeServices).not.toHaveBeenCalled();
    expect(native.appInfo.getLocaleInfo).not.toHaveBeenCalled();
  });

  it("uses a validated explicit locale override before automatic locale inputs", async () => {
    const result = await readCodexLocaleSettings({
      ownerWindow: localeWindow({
        "vscode://codex/get-setting": { value: "en-US" },
        "vscode://codex/locale-info": { ideLocale: "zh-CN", systemLocale: "zh-CN" },
      }),
    });

    expect(result).toEqual({
      status: "ready",
      mode: "explicit",
      localeOverride: "en-US",
      ideLocale: "zh-CN",
      systemLocale: "zh-CN",
      preferredLocale: "en-US",
      source: "override",
    });
  });

  it("uses Codex IDE locale when the setting is automatic", async () => {
    const result = await readCodexLocaleSettings({
      ownerWindow: localeWindow(
        {
          "vscode://codex/get-setting": { value: null },
          "vscode://codex/locale-info": { ideLocale: "zh-cn", systemLocale: "en-US" },
        },
        ["en-US"],
      ),
    });

    expect(result).toMatchObject({
      status: "ready",
      mode: "automatic",
      localeOverride: null,
      preferredLocale: "zh-CN",
      source: "ide",
    });
  });

  it("falls back without treating an unavailable setting as automatic", async () => {
    const ownerWindow = localeWindow({}, ["zh-TW"]);
    const result = await readCodexLocaleSettings({ ownerWindow, timeoutMs: 5 });

    expect(result).toEqual({
      status: "fallback",
      mode: "unavailable",
      localeOverride: undefined,
      ideLocale: undefined,
      systemLocale: undefined,
      preferredLocale: "zh-TW",
      source: "navigator",
    });
  });

  it("writes only a bounded locale override through the fixed setting endpoint", async () => {
    const sentRequests: FetchRequest[] = [];
    const ownerWindow = localeWindow(
      { "vscode://codex/set-setting": { success: true } },
      ["en-US"],
      sentRequests,
    );

    await setCodexLocaleOverride("zh-CN", { ownerWindow });
    await setCodexLocaleOverride(null, { ownerWindow });

    expect(sentRequests.map(({ url, body }) => ({ url, body }))).toEqual([
      {
        url: "vscode://codex/set-setting",
        body: JSON.stringify({ key: "localeOverride", value: "zh-CN" }),
      },
      {
        url: "vscode://codex/set-setting",
        body: JSON.stringify({ key: "localeOverride", value: null }),
      },
    ]);
    await expect(setCodexLocaleOverride("fr-FR" as "zh-CN", { ownerWindow })).rejects.toThrow(
      "Unsupported Codex locale override",
    );
  });

  it("aborts pending fixed requests and rejects invalid timeouts", async () => {
    const controller = new AbortController();
    const ownerWindow = localeWindow({});
    const pending = readCodexLocaleSettings({
      ownerWindow,
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(readCodexLocaleSettings({ ownerWindow, timeoutMs: 0 })).rejects.toThrow(
      "timeout must be positive",
    );
    vi.restoreAllMocks();
  });
});
