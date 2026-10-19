import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeVoiceGateway } from "../src/native-voice-gateway.js";
import { REALTIME_CALL_METHOD } from "@codexhost/shared-contracts";
import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

const homes: string[] = [];
async function gateway() {
  const home = await mkdtemp(path.join(tmpdir(), "native-voice-gateway-"));
  homes.push(home);
  await writeFile(
    path.join(home, "config.toml"),
    'model_provider="custom"\nexperimental_realtime_webrtc_call_base_url="https://gateway.example/v1"\nexperimental_realtime_ws_base_url="https://gateway.example/v1"\n[model_providers.custom]\nenv_key="VOICE_KEY"\n',
  );
  await writeFile(
    path.join(home, "auth.json"),
    JSON.stringify({ access_token: "desktop-oauth-must-not-be-used" }),
  );
  return new NativeVoiceGateway({ CODEX_HOME: home, VOICE_KEY: "gateway-fixture" });
}
const create = () => ({
  operation: "create",
  requestId: "create-fixture",
  body: JSON.stringify({ sdp: "offer", session: { model: "gpt-live-1.1-codex" } }),
  headers: {
    Authorization: "Bearer desktop-oauth",
    "ChatGPT-Account-Id": "disabled-account",
    "OpenAI-Alpha": "quicksilver=v2",
    "Thread-Id": "thread-fixture",
  },
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
describe("native voice gateway", () => {
  it("handles the Desktop RPC without forwarding it to official Codex", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("answer", {
        status: 201,
        headers: { location: "/v1/realtime/calls/rtc_fixture" },
      }),
    );
    vi.stubGlobal("fetch", request);
    await gateway();
    const home = homes.at(-1);
    if (!home) throw new Error("Missing gateway config");
    const fixture = createFixture({
      environment: { CODEX_HOME: home, VOICE_KEY: "gateway-fixture" },
    });
    try {
      writeRequest(fixture.desktopInput, {
        id: "voice-create",
        method: REALTIME_CALL_METHOD,
        params: create(),
      });
      const response = await fixture.collector.waitFor((message) =>
        requestId(message, "voice-create"),
      );
      expect(response).toMatchObject({ result: { status: 201, body: "answer" } });
      expect(request).toHaveBeenCalledOnce();
      expect(fixture.official.stdin.readableLength).toBe(0);
    } finally {
      await stopFixture(fixture);
    }
  });
  it("hangs up a known created call if reading its answer fails", async () => {
    const failedBody = new ReadableStream({
      start(controller) {
        controller.error(new Error("transport secret"));
      },
    });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(failedBody, {
          status: 201,
          headers: { location: "/v1/realtime/calls/rtc_fixture" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", request);
    await expect((await gateway()).request(create())).rejects.toThrow(
      "Configured voice gateway request failed",
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toBe(
      "https://gateway.example/v1/realtime/calls/rtc_fixture/hangup",
    );
  });
  it("uses configured URLs and gateway auth, dropping Desktop account credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("answer", {
        status: 201,
        headers: { location: "/v1/realtime/calls/rtc_fixture", "set-cookie": "private" },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const service = await gateway();
    expect(await service.request(create())).toEqual({
      status: 201,
      body: "answer",
      headers: {
        "content-type": "text/plain;charset=UTF-8",
        location: "/v1/realtime/calls/rtc_fixture",
      },
    });
    const creation = fetcher.mock.calls[0];
    if (!creation) throw new Error("Missing voice call request");
    const [url, init] = creation;
    expect(url).toBe("https://gateway.example/v1/realtime/calls");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer gateway-fixture");
    expect(headers.has("chatgpt-account-id")).toBe(false);
    expect(headers.get("thread-id")).toBe("thread-fixture");
    expect(init?.body).toBe(create().body);
    expect(init?.redirect).toBe("error");
  });
  it("preserves quota status and retry-after for the native caller", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("quota", { status: 429, headers: { "retry-after": "60" } }),
        ),
    );
    expect(await (await gateway()).request(create())).toMatchObject({
      status: 429,
      body: "quota",
      headers: { "retry-after": "60" },
    });
  });
  it("rejects arbitrary URL operations and malformed payloads before sending", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const service = await gateway();
    await expect(
      service.request({ operation: "fetch", url: "https://other.example" }),
    ).rejects.toThrow();
    await expect(service.request({ ...create(), body: "{}" })).rejects.toThrow("Invalid voice");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("cancels an in-flight bootstrap without leaking transport diagnostics", async () => {
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            ready();
            options.signal.addEventListener("abort", () =>
              reject(new Error("secret upstream detail")),
            );
          }),
      ),
    );
    const service = await gateway();
    const result = service.request(create());
    await started;
    await service.request({ operation: "cancel", requestId: "create-fixture" });
    await expect(result).rejects.toThrow("cancelled");
  });
});
