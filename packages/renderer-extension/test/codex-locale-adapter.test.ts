import { describe, expect, it, vi } from "vitest";

import { readCodexLocaleSettings, setCodexLocaleOverride } from "../src/codex-locale-adapter.js";

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
              responseType: "success",
              status: 200,
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
