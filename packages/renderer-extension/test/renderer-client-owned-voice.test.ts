import { afterEach, describe, expect, it, vi } from "vitest";
import { REALTIME_CALL_METHOD } from "@codexhost/shared-contracts";
import {
  CLIENT_OWNED_VOICE_INITIAL_ASSET,
  CLIENT_OWNED_VOICE_SHARED_ASSET,
  installClientOwnedVoiceHook,
  wrapClientOwnedVoiceFetch,
  type NativeVoiceBridge,
} from "../src/renderer-client-owned-voice.js";
import { CPA_LIVE_VOICE_HOOK_GLOBAL } from "../src/renderer-cpa-live-voice-hook.js";

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
  const original = vi.fn(async () => new Response("native"));
  const client = { fetch: original as (url: string, options?: RequestInit) => Promise<Response> };
  const responseError = vi.fn(async (response: Response) =>
    Object.assign(new Error(await response.text()), { status: response.status }),
  );
  return { bridge, dispatch, listeners, client, original, responseError };
}
const url = "/wham/realtime/calls?intent=quicksilver&architecture=avas";
const options = () => ({
  method: "POST",
  body: JSON.stringify({ sdp: "offer", session: { model: "gpt-live-1.1-codex" } }),
});
afterEach(() => vi.useRealTimers());

describe("client-owned voice gateway", () => {
  it("creates the native call through Host rather than Desktop OAuth", async () => {
    const f = fixture();
    const dispose = wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    const response = await f.client.fetch(url, options());
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
          params: expect.objectContaining({ operation: "create", body: options().body }),
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
      ...options(),
      headers: {
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
    });
    const serialized = JSON.stringify(f.dispatch.mock.calls);
    expect(serialized).not.toContain("desktop-oauth");
    expect(serialized).not.toContain("disabled-account");
    expect(serialized).not.toContain("session=private");
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
  it("honors the preference at call time", async () => {
    const f = fixture();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => false, f.responseError);
    await f.client.fetch(url, options());
    expect(f.original).toHaveBeenCalledOnce();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("preserves gateway quota errors without falling back to the signed-in account", async () => {
    const f = fixture({ status: 429, body: "usage_limit_reached", headers: { location: "" } });
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    await expect(f.client.fetch(url, options())).rejects.toMatchObject({
      message: "usage_limit_reached",
      status: 429,
    });
    expect(f.original).not.toHaveBeenCalled();
  });
  it("hangs up an answer that arrives after cancellation", async () => {
    const f = fixture();
    const abort = new AbortController();
    wrapClientOwnedVoiceFetch(f.client, f.bridge, () => true, f.responseError);
    const creation = f.client.fetch(url, { ...options(), signal: abort.signal });
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
      urt: { getInstance: () => f.client },
      mPt: { getInstance: () => f.bridge },
      grt: f.responseError,
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
});
