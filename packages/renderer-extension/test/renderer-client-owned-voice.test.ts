import { afterEach, describe, expect, it, vi } from "vitest";
import { REALTIME_CALL_METHOD } from "@codexhost/shared-contracts";
import {
  CLIENT_OWNED_VOICE_INITIAL_ASSET,
  CLIENT_OWNED_VOICE_SHARED_ASSET,
  installClientOwnedVoiceHook,
  isExternalHarnessComposer,
  rememberVoiceProductExperience,
  wrapClientOwnedVoiceFetch,
  type NativeVoiceBridge,
} from "../src/renderer-client-owned-voice.js";
import { CPA_LIVE_VOICE_HOOK_GLOBAL } from "../src/renderer-cpa-live-voice-hook.js";
import {
  CHAT_LIVE_VOICE_STORAGE_KEY,
  CPA_LIVE_VOICE_STORAGE_KEY,
} from "../src/renderer-cpa-live-voice-preference.js";

function fixture(
  result = { status: 201, body: "answer", headers: { location: "/v1/realtime/calls/rtc_fixture" } },
) {
  const listeners = new Set<(event: unknown) => void>();
  const dispatch = vi.fn((_type: string, value: Record<string, unknown>) => {
    const request = value.request as { id: string; params: { operation: string } };
    queueMicrotask(() => {
      for (const listener of listeners)
        listener({
          hostId: "local",
          message: {
            id: request.id,
            result:
              request.params.operation === "create"
                ? result
                : { status: 204, body: "", headers: {} },
          },
        });
    });
  });
  const bridge: NativeVoiceBridge = {
    dispatchMessage: dispatch,
    subscribe: (_type, listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const original = vi.fn<(url: string, options?: RequestInit) => Promise<Response>>(
    async () => new Response("native"),
  );
  const client = { fetch: original as (url: string, options?: RequestInit) => Promise<Response> };
  const responseError = vi.fn(async (response: Response) =>
    Object.assign(new Error(await response.text()), { status: response.status }),
  );
  return { bridge, dispatch, listeners, client, original, responseError };
}
const url = "/wham/realtime/calls?intent=quicksilver&architecture=avas";
const body = (model: string | undefined) =>
  JSON.stringify({ sdp: "offer", ...(model === undefined ? {} : { session: { model } }) });
const speechBody = () => body("gpt-live-1-codex");
const chatBody = () => body("gpt-live");
const workMeta = {
  "x-codex-turn-metadata": JSON.stringify({ backend_model_name: "gpt-5.3-codex" }),
};
const options = (requestBody: string = speechBody(), headers?: HeadersInit) => ({
  method: "POST" as const,
  body: requestBody,
  ...(headers ? { headers } : {}),
});
const workOptions = (requestBody: string = speechBody()) => options(requestBody, workMeta);
afterEach(() => {
  vi.useRealTimers();
  rememberVoiceProductExperience({ productExperience: "" });
});

describe("client-owned voice gateway", () => {
  it("creates the native call through Host rather than Desktop OAuth", async () => {
    const f = fixture();
    const dispose = wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    const response = await f.client.fetch(url, workOptions());
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("answer");
    expect(response.headers.get("location")).toBe("/v1/realtime/calls/rtc_fixture");
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledWith(
      "mcp-request",
      expect.objectContaining({
        hostId: "local",
        request: expect.objectContaining({
          method: REALTIME_CALL_METHOD,
          params: expect.objectContaining({ operation: "create", body: speechBody() }),
        }),
      }),
    );
    expect(f.listeners.size).toBe(0);
    dispose();
    expect(f.client.fetch).toBe(f.original);
  });
  it("strips Desktop account credentials and cookies before crossing the bridge", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    await f.client.fetch(url, {
      ...workOptions(),
      headers: {
        ...workMeta,
        Authorization: "Bearer desktop-oauth",
        Cookie: "session=private",
        "ChatGPT-Account-Id": "disabled-account",
        "openai-alpha": "quicksilver=v2",
        "Thread-Id": "thread-fixture",
      },
    });
    const params = f.dispatch.mock.calls
      .map(
        ([, value]) => (value.request as { params: { headers?: Record<string, string> } }).params,
      )
      .find((entry) => entry.headers !== undefined);
    expect(params?.headers).toEqual({
      "openai-alpha": "quicksilver=v2",
      "thread-id": "thread-fixture",
      "x-codex-turn-metadata": workMeta["x-codex-turn-metadata"],
    });
    const serialized = JSON.stringify(f.dispatch.mock.calls);
    expect(serialized).not.toContain("desktop-oauth");
    expect(serialized).not.toContain("disabled-account");
    expect(serialized).not.toContain("session=private");
  });
  it("strips Desktop account credentials on an intercepted Chat call too", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => false,
      f.responseError,
      () => true,
    );
    await f.client.fetch(url, {
      ...options(chatBody()),
      headers: {
        Authorization: "Bearer desktop-oauth",
        Cookie: "session=private",
        "ChatGPT-Account-Id": "disabled-account",
        "openai-alpha": "quicksilver=v2",
      },
    });
    expect(f.original).not.toHaveBeenCalled();
    const serialized = JSON.stringify(f.dispatch.mock.calls);
    expect(serialized).not.toContain("desktop-oauth");
    expect(serialized).not.toContain("disabled-account");
    expect(serialized).not.toContain("session=private");
    expect(serialized).toContain("quicksilver=v2");
  });
  it.each([
    "/other",
    "/wham/realtime/calls/rtc_fixture/hangup",
    "https://chatgpt.com/wham/realtime/calls",
    "/wham/realtime/calls-extra",
  ])("preserves unrelated requests: %s", async (path) => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    expect(await (await f.client.fetch(path, options())).text()).toBe("native");
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("treats lastAgent grok as external only for a Work voice launch", () => {
    const grokOwner = {
      localStorage: {
        getItem: () => JSON.stringify({ version: 1, lastAgent: "grok", externalByAgent: {} }),
      },
    };
    rememberVoiceProductExperience({ productExperience: "chat" });
    expect(isExternalHarnessComposer(grokOwner)).toBe(false);
    rememberVoiceProductExperience({ productExperience: "work" });
    expect(isExternalHarnessComposer(grokOwner)).toBe(true);
    rememberVoiceProductExperience({ productExperience: "work" });
    expect(
      isExternalHarnessComposer({
        localStorage: {
          getItem: () => JSON.stringify({ version: 1, lastAgent: "codex", externalByAgent: {} }),
        },
      }),
    ).toBe(false);
  });
  it("sends external Harness voice through Host even when the Work gateway switch is off", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => false,
      f.responseError,
      () => false,
      () => false,
      () => true,
    );
    const response = await f.client.fetch(url, options(speechBody()));
    expect(response.status).toBe(201);
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it.each(["codexhost/grok/grok-4", "codexhost/claude/opus"])(
    "routes the cold overlay's explicit Harness metadata through Host: %s",
    async (model) => {
      const f = fixture();
      // No primary Composer, remembered launch, or lastAgent exists in this realm.
      wrapClientOwnedVoiceFetch(
        f.client,
        f.bridge,
        () => false,
        f.responseError,
        () => false,
        () => false,
        () => false,
      );
      await f.client.fetch(
        url,
        options(speechBody(), {
          "x-codex-turn-metadata": JSON.stringify({ backend_model_name: model }),
        }),
      );
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(f.original).not.toHaveBeenCalled();
    },
  );
  it("honors the Work preference at call time", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => false, f.responseError);
    await f.client.fetch(url, workOptions());
    expect(f.original).toHaveBeenCalledOnce();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it.each([
    ["gpt-live", chatBody()],
    ["shared speech model gpt-live-1-codex", speechBody()],
    ["no session", JSON.stringify({ sdp: "offer" })],
  ])(
    "leaves Chat %s on native /wham so Desktop Chat voice can own Instant Connect",
    async (_name, request) => {
      const f = fixture();
      wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
      expect(await (await f.client.fetch(url, options(request))).text()).toBe("native");
      expect(f.original).toHaveBeenCalledOnce();
      expect(f.original.mock.calls[0]?.[0]).toBe(url);
      expect(f.dispatch).not.toHaveBeenCalled();
    },
  );
  it("records Chat passthrough debug without credentials", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    await f.client.fetch(url, {
      ...options(chatBody()),
      headers: { Authorization: "Bearer secret-token", "Thread-Id": "conv-chat-1" },
    });
    const log = (globalThis as { __codexhostChatVoiceDebug?: unknown[] }).__codexhostChatVoiceDebug;
    expect(JSON.stringify(log)).not.toContain("secret-token");
    expect(JSON.stringify(log)).toContain("chat-native-passthrough");
    expect(JSON.stringify(log)).toContain('"hasThreadId":true');
    const persisted = globalThis.localStorage?.getItem("codexhost.chat-voice-debug.v1");
    if (persisted !== undefined && persisted !== null)
      expect(persisted).toContain("chat-native-passthrough");
  });
  it("keeps Desktop login headers on native Chat /wham", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    await f.client.fetch(url, {
      ...options(chatBody()),
      headers: {
        Authorization: "Bearer desktop-oauth",
        "ChatGPT-Account-Id": "acct-fixture",
      },
    });
    const forwarded = f.original.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(forwarded.Authorization).toBe("Bearer desktop-oauth");
    expect(forwarded["ChatGPT-Account-Id"]).toBe("acct-fixture");
    expect(f.original.mock.calls[0]?.[0]).toBe(url);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("treats a Harness backend model as Work even on the Chat surface", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    await f.client.fetch(
      url,
      options(speechBody(), {
        "x-codex-turn-metadata": JSON.stringify({
          backend_model_name: "codexhost/plugin-v1@grok-test-model",
        }),
      }),
    );
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("treats the Work composer surface as Work without backend metadata", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => true,
      f.responseError,
      () => false,
      () => true,
    );
    await f.client.fetch(url, options(speechBody()));
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("does not treat a gpt-live backend name as Work", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    await f.client.fetch(
      url,
      options(speechBody(), {
        "x-codex-turn-metadata": JSON.stringify({ backend_model_name: "gpt-live-1-codex" }),
      }),
    );
    expect(f.original).toHaveBeenCalledOnce();
    expect(f.original.mock.calls[0]?.[0]).toBe(url);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("routes a Chat call through Host only when the Chat override is on", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => false,
      f.responseError,
      () => true,
    );
    const response = await f.client.fetch(url, options(chatBody()));
    expect(response.status).toBe(201);
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch.mock.calls[0]?.[1]).toMatchObject({
      request: { params: { operation: "create", body: chatBody() } },
    });
  });
  it("preserves gateway quota errors without falling back to the signed-in account", async () => {
    const f = fixture({ status: 429, body: "usage_limit_reached", headers: { location: "" } });
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    await expect(f.client.fetch(url, workOptions())).rejects.toMatchObject({
      message: "usage_limit_reached",
      status: 429,
    });
    expect(f.original).not.toHaveBeenCalled();
  });
  it("hangs up an answer that arrives after cancellation", async () => {
    const f = fixture();
    const abort = new AbortController();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    const creation = f.client.fetch(url, { ...workOptions(), signal: abort.signal });
    abort.abort();
    await expect(creation).rejects.toMatchObject({ name: "AbortError" });
    expect(
      f.dispatch.mock.calls.map(([, value]) => (value.request as { params: unknown }).params),
    ).toContainEqual({ operation: "hangup", callId: "rtc_fixture" });
  });
  it("installs only after both audited assets are present", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const names = [CLIENT_OWNED_VOICE_INITIAL_ASSET];
    const target = {
      [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
        enabled: true,
        auditedDesktopVersion: "26.1007.30912",
        auditedAppInitialAsset: "app-initial-6350d04672d0.js",
      },
      document: {
        querySelectorAll: () => names.map((name) => ({ getAttribute: () => `/assets/${name}` })),
      } as unknown as ParentNode,
      setTimeout,
      clearTimeout,
    };
    const importModule = vi.fn(async () => ({
      Oit: vi.fn(),
      Eit: { getInstance: () => f.client },
      AFt: { getInstance: () => f.bridge },
      Mit: f.responseError,
    }));
    const hook = installClientOwnedVoiceHook({ target, importModule });
    expect(importModule).not.toHaveBeenCalled();
    names.push(CLIENT_OWNED_VOICE_SHARED_ASSET);
    await vi.advanceTimersByTimeAsync(250);
    expect(hook.status).toBe("active");
    expect(importModule).toHaveBeenCalledWith(`app://-/assets/${CLIENT_OWNED_VOICE_SHARED_ASSET}`);
    hook.dispose();
    expect(f.client.fetch).toBe(f.original);
  });
  it("initializes lazy native WebFetch exports before installing on a cold document", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const target = {
      [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
        enabled: true,
        auditedDesktopVersion: "26.1007.30912",
        auditedAppInitialAsset: "app-initial-6350d04672d0.js",
      },
      document: {
        querySelectorAll: () =>
          [CLIENT_OWNED_VOICE_INITIAL_ASSET, CLIENT_OWNED_VOICE_SHARED_ASSET].map((name) => ({
            getAttribute: () => `/assets/${name}`,
          })),
      } as unknown as ParentNode,
      performance: { getEntriesByType: () => [] },
      setTimeout,
      clearTimeout,
    };
    const module: Record<string, unknown> = {
      Oit: vi.fn(() => {
        module.Eit = { getInstance: () => f.client };
        module.AFt = { getInstance: () => f.bridge };
        module.Mit = f.responseError;
      }),
    };
    const hook = installClientOwnedVoiceHook({ target, importModule: async () => module });
    await vi.advanceTimersByTimeAsync(0);
    expect(module.Oit).toHaveBeenCalledOnce();
    expect(hook.status).toBe("active");
    await f.client.fetch(url, workOptions());
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.original).not.toHaveBeenCalled();
    hook.dispose();
  });
  it("still installs with the Work override off and applies the Chat override", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const values = new Map<string, string>([
      [CPA_LIVE_VOICE_STORAGE_KEY, "0"],
      [CHAT_LIVE_VOICE_STORAGE_KEY, "1"],
    ]);
    const target = {
      [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
        enabled: true,
        auditedDesktopVersion: "26.1007.30912",
        auditedAppInitialAsset: "app-initial-6350d04672d0.js",
      },
      localStorage: { getItem: (key: string) => values.get(key) ?? null },
      document: {
        querySelectorAll: () =>
          [CLIENT_OWNED_VOICE_INITIAL_ASSET, CLIENT_OWNED_VOICE_SHARED_ASSET].map((name) => ({
            getAttribute: () => `/assets/${name}`,
          })),
      } as unknown as ParentNode,
      performance: { getEntriesByType: () => [] },
      setTimeout,
      clearTimeout,
    };
    const importModule = vi.fn(async () => ({
      Oit: vi.fn(),
      Eit: { getInstance: () => f.client },
      AFt: { getInstance: () => f.bridge },
      Mit: f.responseError,
    }));
    const hook = installClientOwnedVoiceHook({ target, importModule });
    await vi.advanceTimersByTimeAsync(0);
    expect(hook.status).toBe("active");
    await f.client.fetch(url, options(chatBody()));
    expect(f.dispatch).toHaveBeenCalledOnce();
    await f.client.fetch(url, workOptions());
    expect(f.original).toHaveBeenCalledOnce();
    hook.dispose();
  });
});

describe("explicit Chat launch ownership", () => {
  it("keeps Chat /wham passthrough despite stale Work surface, Harness model and lastAgent", async () => {
    const f = fixture();
    rememberVoiceProductExperience({ productExperience: "chat" });
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => true,
      f.responseError,
      () => false,
      () => true,
      () => true,
    );
    const request = options(speechBody(), {
      "x-codex-turn-metadata": JSON.stringify({ backend_model_name: "codexhost/grok/grok-4" }),
    });
    await f.client.fetch(url, request);
    expect(f.original).toHaveBeenCalledWith(url, request);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("applies the Chat override rather than the Work switch to an explicit Chat launch", async () => {
    const f = fixture();
    rememberVoiceProductExperience({ productExperience: "chat" });
    wrapClientOwnedVoiceFetch(
      f.client,
      f.bridge,
      () => false,
      f.responseError,
      () => true,
      () => true,
      () => false,
    );
    await f.client.fetch(url, workOptions());
    expect(f.original).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
});
