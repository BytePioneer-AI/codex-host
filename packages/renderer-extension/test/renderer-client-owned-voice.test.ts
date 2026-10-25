import { afterEach, describe, expect, it, vi } from "vitest";
import { REALTIME_CALL_METHOD } from "@codexhost/shared-contracts";
import {
  CLIENT_OWNED_VOICE_INITIAL_ASSET,
  CLIENT_OWNED_VOICE_SHARED_ASSET,
  installClientOwnedVoiceHook,
  isExternalHarnessComposer,
  isWorkComposerSurface,
  rememberVoiceProductExperience,
  wrapClientOwnedVoiceFetch,
  type NativeVoiceBridge,
} from "../src/renderer-client-owned-voice.js";
import { CPA_LIVE_VOICE_HOOK_GLOBAL } from "../src/renderer-cpa-live-voice-hook.js";
import { wrapGatewayVoiceStarter } from "../src/renderer-voice-start-capability.js";
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
function sharedExports(f: ReturnType<typeof fixture>) {
  const fetch = { getInstance: () => f.client };
  const bridge = { getInstance: () => f.bridge };
  return {
    Oit: vi.fn(),
    Eit: fetch,
    AFt: bridge,
    Mit: f.responseError,
    Zot: fetch,
    Htr: fetch,
    bIt: bridge,
    Qot: { realtimeVoiceRuntime: vi.fn() },
  };
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
    { experience: "work", model: "gpt-6.1-sol" },
    { experience: "work", model: undefined },
    { experience: "codex", model: "gpt-6.1-sol" },
    { experience: "codex", model: undefined },
  ])(
    "routes an explicit $experience overlay start through Host without a Work composer: $model",
    async ({ experience, model }) => {
      const f = fixture();
      wrapClientOwnedVoiceFetch(
        f.client,
        f.bridge,
        () => true,
        f.responseError,
        () => false,
        () => false,
        () => false,
      );
      const starter = wrapGatewayVoiceStarter(
        () =>
          f.client.fetch(
            url,
            options(
              speechBody(),
              model
                ? { "x-codex-turn-metadata": JSON.stringify({ backend_model_name: model }) }
                : undefined,
            ),
          ),
        {
          qualifies: () => true,
          ready: async () => true,
          prepare: async () => ({ current: () => true, dispose() {} }),
          committed: async () => {},
        },
      );
      const response = (await starter.start({
        productExperience: experience,
        source: "composer_button_new_thread",
        hostId: "local",
      })) as Response;
      expect(response.status).toBe(201);
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(f.original).not.toHaveBeenCalled();
    },
  );
  it.each(["work", "codex"])(
    "uses the Work preference for an explicit %s overlay start when Chat uses gateway",
    async (experience) => {
      const f = fixture();
      rememberVoiceProductExperience({ productExperience: experience });
      wrapClientOwnedVoiceFetch(
        f.client,
        f.bridge,
        () => false,
        f.responseError,
        () => true,
        () => false,
        () => false,
      );
      await f.client.fetch(url, options(speechBody()));
      expect(f.original).toHaveBeenCalledOnce();
      expect(f.dispatch).not.toHaveBeenCalled();
    },
  );
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
    const importModule = vi.fn(async () => sharedExports(f));
    const hook = installClientOwnedVoiceHook({ target, importModule });
    expect(importModule).not.toHaveBeenCalled();
    names.push(CLIENT_OWNED_VOICE_SHARED_ASSET);
    await vi.advanceTimersByTimeAsync(250);
    expect(hook.status).toBe("active");
    expect(importModule).toHaveBeenCalledWith(`app://-/assets/${CLIENT_OWNED_VOICE_SHARED_ASSET}`);
    hook.dispose();
    expect(f.client.fetch).toBe(f.original);
  });
  it.each([
    ["26.1021.31345", "app-initial-feb30b196d11.js", "app-shared-2cae01273bae.js"],
    ["26.1016.62342", "app-initial-dddef47d6ef6.js", "app-shared-fc3316d48427.js"],
    ["26.1016.61520", "app-initial-c95ddb62696e.js", "app-shared-2eda13eb7044.js"],
  ])(
    "routes explicit Work through its qualified %s WebFetch",
    async (desktopVersion, initial, shared) => {
      vi.useFakeTimers();
      const f = fixture();
      const target = {
        [CPA_LIVE_VOICE_HOOK_GLOBAL]: {
          enabled: true,
          desktopVersion,
          auditedDesktopVersion: "26.1007.30912",
          auditedAppInitialAsset: "app-initial-6350d04672d0.js",
        },
        document: {
          querySelectorAll: () =>
            [initial, shared].map((name) => ({ getAttribute: () => `app://-/assets/${name}` })),
        } as unknown as ParentNode,
        setTimeout,
        clearTimeout,
      };
      const importModule = vi.fn(async () => sharedExports(f));
      const hook = installClientOwnedVoiceHook({ target, importModule });
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.status).toBe("active");
      expect(importModule).toHaveBeenCalledWith(`app://-/assets/${shared}`);
      rememberVoiceProductExperience({ productExperience: "work" });
      await f.client.fetch(
        url,
        options(speechBody(), {
          "x-codex-turn-metadata": JSON.stringify({ backend_model_name: "gpt-6.1-sol" }),
        }),
      );
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(f.original).not.toHaveBeenCalled();
      hook.dispose();
      expect(f.client.fetch).toBe(f.original);
    },
  );

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
    Object.assign(target[CPA_LIVE_VOICE_HOOK_GLOBAL], { desktopVersion: "26.1016.62342" });
    const module: Record<string, unknown> = {
      Oit: vi.fn(() => {
        module.Eit = { getInstance: () => f.client };
        module.AFt = { getInstance: () => f.bridge };
        module.Mit = f.responseError;
      }),
    };
    const names = ["app-initial-dddef47d6ef6.js", "app-shared-fc3316d48427.js"];
    target.document = {
      querySelectorAll: () => names.map((name) => ({ getAttribute: () => `/assets/${name}` })),
    } as unknown as ParentNode;
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
    const importModule = vi.fn(async () => sharedExports(f));
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

describe("isWorkComposerSurface", () => {
  function owner(mode: string | null, tabs: { name: string; selected?: boolean }[]) {
    const storage = {
      getItem: (key: string) => (key === "home-composer-mode-v1" ? mode : null),
    };
    const nodes = tabs.map((tab) => ({
      textContent: tab.name,
      getAttribute: (name: string) =>
        name === "aria-selected" ? (tab.selected ? "true" : "false") : "",
    }));
    return {
      localStorage: storage,
      document: { querySelectorAll: () => nodes },
    };
  }

  it("treats a selected Work tab as Work when composer-mode storage is empty", () => {
    expect(
      isWorkComposerSurface(owner(null, [{ name: "Chat" }, { name: "Work", selected: true }])),
    ).toBe(true);
  });

  it("treats a visible official Work composer as Work when storage is empty", () => {
    const composer = {
      getBoundingClientRect: () => ({ width: 800 }),
      closest: () => null,
    };
    expect(
      isWorkComposerSurface({
        localStorage: { getItem: () => null },
        document: {
          querySelectorAll: (selector: string) =>
            selector === "[data-codex-composer-root]"
              ? [composer]
              : selector === "[data-chatgpt-composer]"
                ? []
                : [],
        },
      }),
    ).toBe(true);
  });

  it("does not treat official Chat as Work", () => {
    expect(
      isWorkComposerSurface(owner(null, [{ name: "Chat", selected: true }, { name: "Work" }])),
    ).toBe(false);
  });

  it.each(["zero-size", "hidden", "inert"])(
    "ignores a retained %s Chat composer beside the visible Work composer",
    (hiddenBy) => {
      const work = { getBoundingClientRect: () => ({ width: 800 }), closest: () => null };
      const chat = {
        getBoundingClientRect: () => ({ width: hiddenBy === "zero-size" ? 0 : 800 }),
        closest: () => (hiddenBy === "zero-size" ? null : {}),
      };
      expect(
        isWorkComposerSurface({
          localStorage: { getItem: () => null },
          document: {
            querySelectorAll: (selector: string) =>
              selector === "[data-codex-composer-root]"
                ? [work]
                : selector === "[data-chatgpt-composer]"
                  ? [chat]
                  : [],
          },
        }),
      ).toBe(true);
    },
  );

  it("rejects a Work surface when a visible Chat composer is also present", () => {
    const visible = { getBoundingClientRect: () => ({ width: 800 }), closest: () => null };
    expect(
      isWorkComposerSurface({
        localStorage: { getItem: () => null },
        document: {
          querySelectorAll: (selector: string) =>
            selector === "[data-codex-composer-root]" || selector === "[data-chatgpt-composer]"
              ? [visible]
              : [],
        },
      }),
    ).toBe(false);
  });

  it("keeps explicit chat storage off Work even if a Work tab is selected", () => {
    expect(isWorkComposerSurface(owner("chat", [{ name: "Work", selected: true }]))).toBe(false);
  });
});
